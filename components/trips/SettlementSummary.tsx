"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, ArrowRight, Scale, CheckCircle2, Database, History } from "lucide-react";
import type { Expense } from "@/types/expense";
import type { Trip, TripSettlement } from "@/types/trip";
import type { ContractPaymentEvent } from "@/types/contract";
import type { NetPayment } from "@/lib/settlement/netBalance";
import { computeNetPayments, deriveRawDebts } from "@/lib/settlement/netBalance";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { settlementMemo } from "@/lib/stellar/memo";
import {
  inspectSignedTransaction,
  isSubmissionIndeterminate,
  submitSignedTransaction,
} from "@/lib/stellar/submitTransaction";
import { recordPaymentOnChain } from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/components/ui/Toast";
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  stellarNetworkLabel,
} from "@/lib/utils/constants";
import { PayButton } from "@/components/payment/PayButton";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import type { PaymentState } from "@/hooks/usePayment";
import { cn, formatXLM } from "@/lib/utils";
import { userFacingMessage } from "@/lib/errors/userMessage";
import { sameWallet } from "@/lib/payments/shareOwnership";
import { checkTransactionOnHorizon } from "@/lib/payments/pendingPayments";
import {
  getPendingSettlement,
  isSettlementAlreadyRecorded,
  recordTripSettlement,
  removePendingSettlement,
  savePendingSettlement,
  settlementContractExpenseId,
  type PendingSettlement,
} from "@/lib/settlement/tripSettlements";

interface SettlementSummaryProps {
  trip: Trip;
  expenses: Expense[];
  onChainEvents?: ContractPaymentEvent[];
  /**
   * Recorded settle-up transfers (Issue #203). Balances are
   * owed - paid shares - settlements, so these must be passed for the trip to
   * ever reach "All settled up" through net transfers.
   */
  settlements?: TripSettlement[];
  /** Called with a settlement this client just recorded. */
  onSettlementRecorded?: (settlement: TripSettlement) => void;
  /** Called when a settlement was recorded elsewhere and should be re-fetched. */
  onSettlementsStale?: () => void;
}

/**
 * Arguments for one `recordPaymentOnChain` call. Field names match
 * `RecordPaymentParams` exactly so the record can be spread into the call.
 */
interface PendingOnChainRecord {
  /** DEBTOR: the connected wallet that sent the settlement. */
  debtorPublicKey: string;
  tripId: string;
  /** Per-settlement id, see settlementContractExpenseId. */
  expenseId: string;
  /** CREDITOR: the wallet that received the settlement. */
  creditorPublicKey: string;
  amountXlm: string;
  txHash: string;
  ledger: number;
}

function isAlreadyOnChain(error?: string): boolean {
  return Boolean(error && /already (marked as paid|settled on-chain)/i.test(error));
}

function filterMemberEvents(
  expenses: Expense[],
  events: ContractPaymentEvent[],
): ContractPaymentEvent[] {
  const membersByExpense = new Map(
    expenses.map((expense) => [
      expense.id,
      new Set(
        [...expense.members, ...expense.shares]
          .map((member) => member.walletAddress?.toLowerCase())
          .filter((address): address is string => Boolean(address)),
      ),
    ]),
  );

  return events.filter((event) =>
    membersByExpense.get(event.expenseId)?.has(event.member.toLowerCase()) ?? false,
  );
}

function deriveUnverifiedClaims(
  expenses: Expense[],
  onChainEvents: ContractPaymentEvent[] = [],
): Map<string, number> {
  const unverifiedOnChainSet = new Set(
    onChainEvents
      .filter((e) => e.attested !== true)
      .map((e) => `${e.expenseId}-${e.member.toLowerCase()}`),
  );

  const claims = new Map<string, number>();
  for (const expense of expenses) {
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    if (!payer?.walletAddress) continue;

    for (const share of expense.shares) {
      if (share.paid || share.memberId === expense.paidByMemberId || !share.walletAddress) continue;
      if (!unverifiedOnChainSet.has(`${expense.id}-${share.walletAddress.toLowerCase()}`)) continue;

      const key = `${share.walletAddress.toLowerCase()}-${payer.walletAddress.toLowerCase()}`;
      claims.set(key, (claims.get(key) ?? 0) + 1);
    }
  }

  return claims;
}

/**
 * One suggested net transfer. Paying it records ONE settlement row with the
 * exact amount that moved (Issue #203); it never marks gross shares paid,
 * because a net amount does not line up with whole shares.
 */
function NetPaymentRow({
  payment,
  index,
  tripId,
  unverifiedClaimCount,
  onSettlementRecorded,
  onSettlementsStale,
  onReceiptFailed,
}: {
  payment: NetPayment;
  index: number;
  tripId: string;
  unverifiedClaimCount?: number;
  onSettlementRecorded?: (settlement: TripSettlement) => void;
  onSettlementsStale?: () => void;
  onReceiptFailed: (record: PendingOnChainRecord, message: string) => void;
}) {
  const {
    publicKey,
    isNetworkCompatible,
    refreshNetwork,
    expectedNetwork,
  } = useWallet();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  // A transfer that moved but whose settlement row is not recorded yet.
  const [pending, setPending] = useState<PendingSettlement | null>(null);

  // Resume a transfer left over from an earlier visit, so it is recorded
  // instead of paid twice.
  useEffect(() => {
    if (!publicKey || !sameWallet(publicKey, payment.fromWallet)) return;
    const stored = getPendingSettlement(publicKey, tripId, payment.fromId, payment.toId);
    if (!stored) return;
    setPending(stored);
    setPaymentState(
      stored.status === "submitted"
        ? {
            status: "paid_unrecorded",
            hash: stored.txHash,
            ledger: stored.ledger ?? 0,
            onChain: false,
            message: "A previous settlement transfer has not been recorded yet",
          }
        : {
            status: "pending_confirmation",
            hash: stored.txHash,
            message: "A previous settlement transfer may still be confirming. Check before paying again.",
          },
    );
  }, [publicKey, tripId, payment.fromId, payment.toId, payment.fromWallet]);

  const isLoading =
    paymentState.status === "building" ||
    paymentState.status === "signing" ||
    paymentState.status === "submitting" ||
    paymentState.status === "recording" ||
    paymentState.status === "verifying";

  const isDone =
    paymentState.status === "success" ||
    paymentState.status === "partial_success" ||
    paymentState.status === "paid_unrecorded";

  // Only the debtor of a net payment may send it (Issue #208).
  const canPay =
    Boolean(publicKey) &&
    Boolean(payment.toWallet) &&
    isNetworkCompatible &&
    paymentState.status === "idle" &&
    !pending &&
    sameWallet(publicKey, payment.fromWallet);

  /**
   * Money has moved: write the on-chain receipt for the exact net amount, then
   * the settlement row that changes everyone's balance.
   */
  const finalize = async (entry: PendingSettlement, hash: string, ledger: number) => {
    let onChain = false;
    if (CONTRACT_ID && entry.tripId) {
      const rec: PendingOnChainRecord = {
        debtorPublicKey: entry.fromWallet,
        tripId: entry.tripId,
        expenseId: settlementContractExpenseId(hash),
        creditorPublicKey: entry.toWallet,
        amountXlm: entry.amount,
        txHash: hash,
        ledger,
      };
      setPaymentState({ status: "recording", step: "simulating" });
      const res = await recordPaymentOnChain({
        ...rec,
        onStatus: (step) => setPaymentState({ status: "recording", step }),
      });
      if (res.success || isAlreadyOnChain(res.error)) {
        onChain = true;
      } else {
        onReceiptFailed(rec, res.error ?? "On-chain recording failed.");
      }
    }

    let recorded: TripSettlement | null = null;
    try {
      recorded = await recordTripSettlement(entry.fromWallet, {
        tripId: entry.tripId,
        fromMemberId: entry.fromMemberId,
        toMemberId: entry.toMemberId,
        amount: entry.amount,
        txHash: hash,
      });
    } catch (err) {
      if (!isSettlementAlreadyRecorded(err)) {
        const failed: PendingSettlement = { ...entry, txHash: hash, status: "submitted", ledger };
        savePendingSettlement(failed);
        setPending(failed);
        setPaymentState({
          status: "paid_unrecorded",
          hash,
          ledger,
          onChain,
          message: userFacingMessage(err).message,
        });
        toastInfo(
          "Settlement sent — recording pending",
          "Your XLM transfer went through. Retry recording — do not pay again.",
        );
        return;
      }
    }

    removePendingSettlement(entry.fromWallet, entry.tripId, entry.fromMemberId, entry.toMemberId, hash);
    setPending(null);
    setPaymentState({ status: "success", hash, ledger, onChain });
    toastSuccess(
      "Settlement sent!",
      onChain
        ? `Paid ${formatXLM(entry.amount)} XLM to ${payment.to} · Recorded on-chain ✓`
        : `Paid ${formatXLM(entry.amount)} XLM to ${payment.to}`,
    );
    if (recorded) onSettlementRecorded?.(recorded);
    else onSettlementsStale?.();
  };

  const handlePay = async () => {
    if (!publicKey || !payment.toWallet) return;
    if (!sameWallet(publicKey, payment.fromWallet)) {
      toastError("Payment blocked", `Only ${payment.from} can send this settlement, from their own wallet.`);
      return;
    }
    const liveNetwork = await refreshNetwork();
    if (liveNetwork !== expectedNetwork) {
      toastError(
        "Payment blocked",
        liveNetwork
          ? `Switch your wallet to ${stellarNetworkLabel(expectedNetwork)} before paying.`
          : `SettleX could not verify your wallet is on ${stellarNetworkLabel(expectedNetwork)}.`,
      );
      return;
    }

    try {
      setPaymentState({ status: "building" });
      const { xdr } = await buildPaymentTransaction({
        sourcePublicKey:      publicKey,
        destinationPublicKey: payment.toWallet,
        amount:               payment.amount,
        memo:                 settlementMemo(tripId, publicKey, payment.toWallet),
      });

      setPaymentState({ status: "signing" });
      toastInfo("Waiting for wallet signature…", "Confirm the settlement payment.");
      const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE, publicKey);
      const signed = inspectSignedTransaction(signedXDR);

      // Durable before submission: the hash is fixed once signed.
      const signedEntry: PendingSettlement = {
        tripId,
        fromMemberId: payment.fromId,
        toMemberId: payment.toId,
        fromWallet: publicKey,
        toWallet: payment.toWallet,
        amount: payment.amount,
        txHash: signed.hash,
        status: "signed",
        ledger: null,
        createdAt: new Date().toISOString(),
      };
      savePendingSettlement(signedEntry);

      setPaymentState({ status: "submitting" });
      let result: { hash: string; ledger: number };
      try {
        const submitRes = await submitSignedTransaction(signedXDR);
        result = { hash: submitRes.hash || signed.hash, ledger: submitRes.ledger };
      } catch (err) {
        if (isSubmissionIndeterminate(err)) {
          setPending(signedEntry);
          setPaymentState({
            status: "pending_confirmation",
            hash: signed.hash,
            message: userFacingMessage(err).message,
          });
          toastInfo(
            "Payment awaiting confirmation",
            "Stellar has not confirmed the transfer yet. Don't pay again — check again shortly.",
          );
          return;
        }
        removePendingSettlement(publicKey, tripId, payment.fromId, payment.toId, signed.hash);
        throw err;
      }

      const submittedEntry: PendingSettlement = {
        ...signedEntry,
        txHash: result.hash,
        status: "submitted",
        ledger: result.ledger,
      };
      savePendingSettlement(submittedEntry);
      await finalize(submittedEntry, result.hash, result.ledger);
    } catch (err: unknown) {
      const msg        = err instanceof Error ? err.message : "Payment failed";
      const isRejected = /reject|denied|cancel/i.test(msg);
      const display    = isRejected
        ? "You rejected the payment in Freighter."
        : userFacingMessage(err).message;
      toastError(isRejected ? "Transaction cancelled" : "Payment failed", display);
      setPaymentState({ status: "error", message: display });
    }
  };

  const retryRecording = async () => {
    if (!pending || paymentState.status !== "paid_unrecorded") return;
    await finalize(pending, paymentState.hash, paymentState.ledger);
  };

  const checkPendingConfirmation = async (hash: string) => {
    if (!pending) return;
    setPaymentState({ status: "verifying", hash });
    const horizon = await checkTransactionOnHorizon(hash);
    if (horizon.state === "failed") {
      removePendingSettlement(pending.fromWallet, pending.tripId, pending.fromMemberId, pending.toMemberId, hash);
      setPending(null);
      setPaymentState({
        status: "error",
        message: "The earlier transfer failed on the Stellar network, so no XLM moved. You can pay again.",
      });
      return;
    }
    if (horizon.state !== "confirmed") {
      setPaymentState({
        status: "pending_confirmation",
        hash,
        message: horizon.state === "unknown"
          ? "Could not reach Stellar to confirm the earlier transfer. Check again shortly."
          : "Stellar has not confirmed the earlier transfer yet. Check again shortly.",
      });
      toastInfo("Still awaiting confirmation", "Stellar has not confirmed the transfer yet.");
      return;
    }
    const confirmed: PendingSettlement = { ...pending, status: "submitted", ledger: horizon.ledger };
    savePendingSettlement(confirmed);
    await finalize(confirmed, hash, horizon.ledger);
  };

  const shownAmount = pending?.amount ?? payment.amount;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.06 }}
      className={cn(
        "flex flex-col gap-2 p-3.5 rounded-xl border transition-all",
        isDone ? "bg-[#F0FFDB] border-[#B9FF66]/40" : "bg-white border-[#E5E5E5]",
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 min-w-0 text-sm font-semibold text-[#0F0F14]">
          <span className="truncate">{payment.from}</span>
          <ArrowRight size={13} className="text-[#B9FF66] shrink-0" />
          <span className="truncate">{payment.to}</span>
        </div>

        <div className="flex items-center justify-between sm:justify-end gap-2">
          <span className="text-sm font-bold">
            {formatXLM(shownAmount)}{" "}
            <span className="text-[10px] font-normal text-[#888]">XLM</span>
          </span>

          {isDone ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#B9FF66]/30 text-[#2D6600] rounded-full">
              <CheckCircle2 size={9} /> Paid
            </span>
          ) : (
            <PayButton
              amount={payment.amount}
              recipientName={payment.to}
              onClick={handlePay}
              isLoading={isLoading}
              disabled={!canPay}
              size="sm"
            />
          )}
        </div>
      </div>

      {paymentState.status !== "idle" && (
        <div className="mt-1">
          <PaymentStatus
            state={paymentState}
            onReset={paymentState.status === "error" ? () => setPaymentState({ status: "idle" }) : undefined}
            onRetryRecording={
              paymentState.status === "pending_confirmation"
                ? () => checkPendingConfirmation(paymentState.hash)
                : paymentState.status === "paid_unrecorded" && pending
                ? retryRecording
                : undefined
            }
          />
        </div>
      )}

      {!isDone && !!unverifiedClaimCount && (
        <p className="inline-flex items-center gap-1 text-[10px] font-semibold text-[#8A5A00] pl-1">
          <AlertCircle size={11} className="shrink-0" />
          {payment.from} reports paid - unverified
        </p>
      )}

      {!isDone && paymentState.status === "idle" && publicKey && !sameWallet(publicKey, payment.fromWallet) && (
        <p className="text-[10px] text-[#AAA] pl-1">
          Connect {payment.from}&apos;s wallet to pay
        </p>
      )}
    </motion.div>
  );
}

/**
 * Failed on-chain receipts for settlements already recorded in the database.
 * Lives in the summary rather than the row, because a recorded settlement
 * removes its row from the suggested transfers.
 */
function PendingReceipts({
  receipts,
  onRetried,
}: {
  receipts: Array<{ record: PendingOnChainRecord; message: string }>;
  onRetried: (txHash: string, stillFailing?: string) => void;
}) {
  const { refreshNetwork, expectedNetwork } = useWallet();
  const { success: toastSuccess, error: toastError } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const retry = async (record: PendingOnChainRecord) => {
    const liveNetwork = await refreshNetwork();
    if (liveNetwork !== expectedNetwork) {
      toastError(
        "Payment blocked",
        `Switch your wallet to ${stellarNetworkLabel(expectedNetwork)} before retrying.`,
      );
      return;
    }
    setBusy(record.txHash);
    const res = await recordPaymentOnChain(record);
    setBusy(null);
    if (res.success || isAlreadyOnChain(res.error)) {
      onRetried(record.txHash);
      toastSuccess("On-chain record recovered", "Settlement is now confirmed in the contract.");
    } else {
      onRetried(record.txHash, res.error ?? "On-chain retry failed.");
      toastError("On-chain retry failed", res.error ?? "On-chain retry failed.");
    }
  };

  if (receipts.length === 0) return null;
  return (
    <div className="space-y-2">
      {receipts.map(({ record, message }) => (
        <PaymentStatus
          key={record.txHash}
          state={
            busy === record.txHash
              ? { status: "recording", step: "simulating" }
              : {
                  status: "partial_success",
                  hash: record.txHash,
                  ledger: record.ledger,
                  onChain: false,
                  message,
                }
          }
          onRetryOnChain={() => void retry(record)}
        />
      ))}
    </div>
  );
}

function SettlementHistory({
  settlements,
  trip,
}: {
  settlements: TripSettlement[];
  trip: Trip;
}) {
  if (settlements.length === 0) return null;
  const nameOf = (id: string) => trip.members.find((m) => m.id === id)?.name ?? "Member";
  return (
    <div className="mt-4 pt-3 border-t border-[#F0F0F0] space-y-1.5">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[#AAA]">
        <History size={10} /> Recorded settlements
      </p>
      {settlements.map((s) => (
        <div key={s.txHash} className="flex items-center justify-between gap-2 text-xs text-[#555]">
          <span className="flex items-center gap-1.5 min-w-0">
            <span className="truncate">{nameOf(s.fromMemberId)}</span>
            <ArrowRight size={11} className="text-[#B9FF66] shrink-0" />
            <span className="truncate">{nameOf(s.toMemberId)}</span>
          </span>
          <span className="font-semibold shrink-0">{formatXLM(s.amount)} XLM</span>
        </div>
      ))}
    </div>
  );
}

export function SettlementSummary({
  trip,
  expenses,
  onChainEvents = [],
  settlements = [],
  onSettlementRecorded,
  onSettlementsStale,
}: SettlementSummaryProps) {
  const memberEvents     = useMemo(() => filterMemberEvents(expenses, onChainEvents), [expenses, onChainEvents]);
  const rawDebts         = useMemo(() => deriveRawDebts(expenses, memberEvents), [expenses, memberEvents]);
  const unverifiedClaims = useMemo(() => deriveUnverifiedClaims(expenses, memberEvents), [expenses, memberEvents]);
  const eventCounts      = useMemo(() => ({
    attested: memberEvents.filter((event) => event.attested === true).length,
    selfReported: memberEvents.filter((event) => event.attested !== true).length,
  }), [memberEvents]);
  // owed - paid shares - settlements (Issue #203)
  const netPayments      = useMemo(
    () => computeNetPayments(rawDebts, settlements),
    [rawDebts, settlements],
  );

  const [receipts, setReceipts] = useState<Array<{ record: PendingOnChainRecord; message: string }>>([]);
  const addReceipt = (record: PendingOnChainRecord, message: string) =>
    setReceipts((prev) => [...prev.filter((r) => r.record.txHash !== record.txHash), { record, message }]);
  const onRetried = (txHash: string, stillFailing?: string) =>
    setReceipts((prev) =>
      stillFailing
        ? prev.map((r) => (r.record.txHash === txHash ? { ...r, message: stillFailing } : r))
        : prev.filter((r) => r.record.txHash !== txHash),
    );

  if (netPayments.length === 0) {
    return (
      <div className="space-y-3">
        <PendingReceipts receipts={receipts} onRetried={onRetried} />
        <div className="flex flex-col items-center gap-2 py-8 text-center rounded-xl border border-dashed border-[#D0D0D0]">
          <Scale size={20} className="text-[#B9FF66]" />
          <p className="text-sm font-semibold text-[#0F0F14]">All settled up!</p>
          <p className="text-xs text-[#AAA]">No outstanding balances in this trip.</p>
        </div>
        <SettlementHistory settlements={settlements} trip={trip} />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Scale size={14} className="text-[#B9FF66]" />
          <h3 className="text-sm font-bold text-[#0F0F14]">
            Settlement ({netPayments.length} payment{netPayments.length !== 1 ? "s" : ""})
          </h3>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {eventCounts.attested > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#2D6600] bg-[#B9FF66]/20 px-2 py-0.5 rounded-full">
              <Database size={9} />
              {eventCounts.attested} verified on-chain
            </span>
          )}
          {eventCounts.selfReported > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#8A5A00] bg-[#FFF2CC] px-2 py-0.5 rounded-full">
              <AlertCircle size={9} />
              {eventCounts.selfReported} self-reported
            </span>
          )}
        </div>
      </div>

      <PendingReceipts receipts={receipts} onRetried={onRetried} />

      {netPayments.map((p, i) => (
        <NetPaymentRow
          key={`${p.fromId}-${p.toId}`}
          payment={p}
          index={i}
          tripId={trip.id}
          onSettlementRecorded={onSettlementRecorded}
          onSettlementsStale={onSettlementsStale}
          onReceiptFailed={addReceipt}
          unverifiedClaimCount={
            p.fromWallet && p.toWallet
              ? unverifiedClaims.get(`${p.fromWallet.toLowerCase()}-${p.toWallet.toLowerCase()}`)
              : undefined
          }
        />
      ))}

      <SettlementHistory settlements={settlements} trip={trip} />
    </div>
  );
}
