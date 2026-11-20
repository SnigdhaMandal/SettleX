"use client";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, ArrowRight, Scale, CheckCircle2, Database } from "lucide-react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import type { ContractPaymentEvent } from "@/types/contract";
import type { NetPayment, RawDebt } from "@/lib/settlement/netBalance";
import { computeNetPayments } from "@/lib/settlement/netBalance";
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
import { useExpense } from "@/hooks/useExpense";
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
import { selectCoveredShares } from "@/lib/settlement/shareBudget";
import {
  checkTransactionOnHorizon,
  deletePendingPaymentRemote,
  removePendingPaymentLocal,
  savePendingPaymentLocal,
  syncPendingPaymentRemote,
  type PendingPayment,
} from "@/lib/payments/pendingPayments";

interface SettlementSummaryProps {
  trip: Trip;
  expenses: Expense[];
  onChainEvents?: ContractPaymentEvent[];
}

function isAlreadyRecorded(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  return /already marked as paid|already used on another/i.test(message);
}

interface PendingOnChainRecord {
  memberPublicKey: string;
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  amountXlm: string;
  txHash: string;
  ledger: number;
}

interface PendingShareRecord {
  expenseId: string;
  memberId: string;
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

function deriveRawDebts(expenses: Expense[], onChainEvents: ContractPaymentEvent[] = []): RawDebt[] {
  const attestedOnChainSet = new Set(
    onChainEvents
      .filter((e) => e.attested === true)
      .map((e) => `${e.expenseId}-${e.member.toLowerCase()}`),
  );
  
  const debts: RawDebt[] = [];
  for (const expense of expenses) {
    for (const share of expense.shares) {
      const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
      if (!payer || share.memberId === expense.paidByMemberId) continue;
      
      const isPaidOnChain =
        share.walletAddress &&
        attestedOnChainSet.has(`${expense.id}-${share.walletAddress.toLowerCase()}`);
      if (share.paid || isPaidOnChain) continue;
      
      debts.push({
        from:       share.name,
        fromId:     share.memberId,
        to:         payer.name,
        toId:       payer.id,
        amount:     share.amount,
        fromWallet: share.walletAddress,
        toWallet:   payer.walletAddress,
      });
    }
  }
  return debts;
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

function NetPaymentRow({
  payment,
  index,
  tripId,
  expenses,
  unverifiedClaimCount,
}: {
  payment: NetPayment;
  index: number;
  tripId: string;
  expenses: Expense[];
  unverifiedClaimCount?: number;
}) {
  const {
    publicKey,
    isNetworkCompatible,
    refreshNetwork,
    expectedNetwork,
  } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  const [pendingOnChain, setPendingOnChain] = useState<PendingOnChainRecord[] | null>(null);
  const [pendingShares, setPendingShares] = useState<{
    hash: string;
    ledger: number;
    shares: PendingShareRecord[];
    onChain: boolean;
  } | null>(null);

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

  const canPay =
    Boolean(publicKey) &&
    Boolean(payment.toWallet) &&
    isNetworkCompatible &&
    paymentState.status === "idle" &&
    publicKey === payment.fromWallet;

  const handlePay = async () => {
    if (!publicKey || !payment.toWallet) return;
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

    const coveredShares = selectCoveredShares(payment, expenses);
    let pendingList: PendingPayment[] = [];

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
      pendingList = coveredShares.map((cs) => {
        const exp = expenses.find((e) => e.id === cs.expenseId);
        const sh = exp?.shares.find((s) => s.memberId === cs.memberId);
        return {
          expenseId: cs.expenseId,
          memberId: cs.memberId,
          txHash: signed.hash,
          payerWallet: publicKey,
          destinationWallet: payment.toWallet!,
          amount: sh?.amount || "0",
          tripId,
          status: "signed" as const,
          ledger: null,
          validUntil: signed.validUntil,
          onChainRecorded: false,
          createdAt: new Date().toISOString(),
        };
      });

      for (const p of pendingList) {
        savePendingPaymentLocal(p);
        void syncPendingPaymentRemote(p);
      }

      setPaymentState({ status: "submitting" });
      let result: { hash: string; ledger: number };
      try {
        const submitRes = await submitSignedTransaction(signedXDR);
        result = {
          hash: submitRes.hash || signed.hash,
          ledger: submitRes.ledger,
        };
      } catch (err) {
        if (isSubmissionIndeterminate(err)) {
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
        for (const p of pendingList) {
          removePendingPaymentLocal(p.payerWallet, p.expenseId, p.memberId, p.txHash);
          void deletePendingPaymentRemote(p.payerWallet, p.expenseId, p.memberId, p.txHash);
        }
        throw err;
      }

      // Money has moved on Stellar. Update pending entries to submitted.
      const submittedHash = result.hash || signed.hash;
      pendingList = pendingList.map((p) => ({
        ...p,
        txHash: submittedHash,
        status: "submitted" as const,
        ledger: result.ledger,
      }));
      for (const p of pendingList) {
        savePendingPaymentLocal(p);
      }

      // Record settlements on-chain per covered share (Issue #209 / SX-043)
      let onChain = false;
      let onChainError: string | null = null;
      const failedOnChain: PendingOnChainRecord[] = [];

      if (CONTRACT_ID && tripId && coveredShares.length > 0) {
        for (const cs of coveredShares) {
          const exp = expenses.find((e) => e.id === cs.expenseId);
          const sh = exp?.shares.find((s) => s.memberId === cs.memberId);
          const expPayer = exp?.members.find((m) => m.id === exp.paidByMemberId);
          const payerWallet = expPayer?.walletAddress || payment.toWallet!;
          const shareAmount = sh?.amount || "0";

          const rec: PendingOnChainRecord = {
            memberPublicKey: publicKey,
            tripId,
            expenseId: cs.expenseId,
            payerPublicKey: payerWallet,
            amountXlm: shareAmount,
            txHash: submittedHash,
            ledger: result.ledger,
          };

          setPaymentState({ status: "recording", step: "simulating" });
          const contractRes = await recordPaymentOnChain({
            ...rec,
            onStatus: (step) => setPaymentState({ status: "recording", step }),
          });

          if (contractRes.success) {
            // Succeeded
          } else if (contractRes.error && /already (marked as paid|settled on-chain)/i.test(contractRes.error)) {
            // Already recorded
          } else {
            onChainError = contractRes.error ?? "On-chain recording failed.";
            failedOnChain.push(rec);
          }
        }

        if (failedOnChain.length === 0) {
          onChain = true;
          for (const p of pendingList) {
            savePendingPaymentLocal({ ...p, onChainRecorded: true });
          }
        } else {
          setPendingOnChain(failedOnChain);
        }
      }

      // Only close shares up to the net amount actually transferred.
      // A netted payment may be smaller than the gross obligations it represents
      // (e.g. A owes B 10 XLM and B owes A 4 XLM → net 6 XLM transfer). Marking
      // ALL of A's shares paid would write off 10 XLM while only 6 XLM moved.
      const failedDbShares: PendingShareRecord[] = [];
      for (const share of coveredShares) {
        try {
          await markSharePaid(share.expenseId, share.memberId, submittedHash);
          removePendingPaymentLocal(publicKey, share.expenseId, share.memberId, submittedHash);
          void deletePendingPaymentRemote(publicKey, share.expenseId, share.memberId, submittedHash);
        } catch (err) {
          if (isAlreadyRecorded(err)) {
            removePendingPaymentLocal(publicKey, share.expenseId, share.memberId, submittedHash);
            void deletePendingPaymentRemote(publicKey, share.expenseId, share.memberId, submittedHash);
          } else {
            failedDbShares.push({ expenseId: share.expenseId, memberId: share.memberId });
          }
        }
      }

      if (failedDbShares.length > 0) {
        setPendingShares({
          hash: submittedHash,
          ledger: result.ledger,
          shares: failedDbShares,
          onChain,
        });
        setPaymentState({
          status: "paid_unrecorded",
          hash: submittedHash,
          ledger: result.ledger,
          onChain,
          message: "Could not update some expense share records in the database.",
        });
        toastInfo("Settlement sent — recording pending", "Your XLM transfer went through. Retry recording — do not pay again.");
        return;
      }

      if (failedOnChain.length > 0) {
        setPaymentState({
          status: "partial_success",
          hash: submittedHash,
          ledger: result.ledger,
          onChain: false,
          message: onChainError ?? "On-chain recording failed.",
        });
        toastInfo(
          "Payment sent, on-chain record pending",
          "XLM transfer succeeded. Use retry to record it on-chain.",
        );
        return;
      }

      setPaymentState({
        status: "success",
        hash: submittedHash,
        ledger: result.ledger,
        onChain,
      });
      toastSuccess(
        "Settlement sent!",
        onChain
          ? `Paid ${formatXLM(payment.amount)} XLM to ${payment.to} · Recorded on-chain ✓`
          : `Paid ${formatXLM(payment.amount)} XLM to ${payment.to}`,
      );
    } catch (err: unknown) {
      const msg        = err instanceof Error ? err.message : "Payment failed";
      const isRejected = /reject|denied|cancel/i.test(msg);
      const display    = isRejected
        ? "You rejected the payment in Freighter."
        : userFacingMessage(err).message;
      toastError(
        isRejected ? "Transaction cancelled" : "Payment failed",
        display,
      );
      setPaymentState({ status: "error", message: display });
    }
  };

  const retryOnChainRecord = async () => {
    if (!pendingOnChain || pendingOnChain.length === 0) return;
    const liveNetwork = await refreshNetwork();
    if (liveNetwork !== expectedNetwork) {
      toastError(
        "Payment blocked",
        liveNetwork
          ? `Switch your wallet to ${stellarNetworkLabel(expectedNetwork)} before retrying.`
          : `SettleX could not verify your wallet is on ${stellarNetworkLabel(expectedNetwork)}.`,
      );
      return;
    }

    const stillFailed: PendingOnChainRecord[] = [];
    let lastError: string | null = null;
    let lastLedger = pendingOnChain[0].ledger;

    for (const rec of pendingOnChain) {
      setPaymentState({ status: "recording", step: "simulating" });
      const contractResult = await recordPaymentOnChain({
        ...rec,
        onStatus: (step) => setPaymentState({ status: "recording", step }),
      });
      if (contractResult.success) {
        if (contractResult.ledger) lastLedger = contractResult.ledger;
      } else if (contractResult.error && /already (marked as paid|settled on-chain)/i.test(contractResult.error)) {
        // Already recorded
      } else {
        lastError = contractResult.error ?? "On-chain retry failed.";
        stillFailed.push(rec);
      }
    }

    if (stillFailed.length > 0) {
      setPendingOnChain(stillFailed);
      setPaymentState({
        status: "partial_success",
        hash: pendingOnChain[0].txHash,
        ledger: lastLedger,
        onChain: false,
        message: lastError ?? "On-chain retry failed.",
      });
      toastError("On-chain retry failed", lastError ?? "On-chain retry failed.");
      return;
    }

    const completedHash = pendingOnChain[0].txHash;
    setPendingOnChain(null);
    setPaymentState({
      status: "success",
      hash: completedHash,
      ledger: lastLedger,
      onChain: true,
    });
    toastSuccess("On-chain record recovered", "Settlement is now confirmed in the contract.");
  };

  const retryRecording = async () => {
    if (!pendingShares || pendingShares.shares.length === 0) return;
    const stillFailed: PendingShareRecord[] = [];

    for (const s of pendingShares.shares) {
      try {
        await markSharePaid(s.expenseId, s.memberId, pendingShares.hash);
        if (publicKey) {
          removePendingPaymentLocal(publicKey, s.expenseId, s.memberId, pendingShares.hash);
          void deletePendingPaymentRemote(publicKey, s.expenseId, s.memberId, pendingShares.hash);
        }
      } catch (err) {
        if (!isAlreadyRecorded(err)) {
          stillFailed.push(s);
        } else if (publicKey) {
          removePendingPaymentLocal(publicKey, s.expenseId, s.memberId, pendingShares.hash);
          void deletePendingPaymentRemote(publicKey, s.expenseId, s.memberId, pendingShares.hash);
        }
      }
    }

    if (stillFailed.length > 0) {
      setPendingShares({ ...pendingShares, shares: stillFailed });
      toastError("Recording still failing", "Failed to update some shares.");
      return;
    }

    const completedHash = pendingShares.hash;
    const completedLedger = pendingShares.ledger;
    const completedOnChain = pendingShares.onChain;
    setPendingShares(null);
    setPaymentState({
      status: "success",
      hash: completedHash,
      ledger: completedLedger,
      onChain: completedOnChain,
    });
    toastSuccess("Settlement recorded!", "All shares updated in database.");
  };

  const checkPendingConfirmation = async (hash: string) => {
    setPaymentState({ status: "verifying", hash });
    const horizon = await checkTransactionOnHorizon(hash);
    if (horizon.state === "failed") {
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

    const coveredShares = selectCoveredShares(payment, expenses);
    let onChain = false;
    let onChainError: string | null = null;
    const failedOnChain: PendingOnChainRecord[] = [];

    if (CONTRACT_ID && tripId && coveredShares.length > 0) {
      for (const cs of coveredShares) {
        const exp = expenses.find((e) => e.id === cs.expenseId);
        const sh = exp?.shares.find((s) => s.memberId === cs.memberId);
        const expPayer = exp?.members.find((m) => m.id === exp.paidByMemberId);
        const payerWallet = expPayer?.walletAddress || payment.toWallet;
        const rec: PendingOnChainRecord = {
          memberPublicKey: publicKey!,
          tripId,
          expenseId: cs.expenseId,
          payerPublicKey: payerWallet,
          amountXlm: sh?.amount || "0",
          txHash: hash,
          ledger: horizon.ledger,
        };
        setPaymentState({ status: "recording", step: "simulating" });
        const contractRes = await recordPaymentOnChain({
          ...rec,
          onStatus: (step) => setPaymentState({ status: "recording", step }),
        });
        if (!contractRes.success && !(contractRes.error && /already (marked as paid|settled on-chain)/i.test(contractRes.error))) {
          onChainError = contractRes.error ?? "On-chain recording failed.";
          failedOnChain.push(rec);
        }
      }
      if (failedOnChain.length === 0) {
        onChain = true;
      } else {
        setPendingOnChain(failedOnChain);
      }
    }

    for (const share of coveredShares) {
      try {
        await markSharePaid(share.expenseId, share.memberId, hash);
      } catch {
        // Ignore or handled
      }
    }

    if (failedOnChain.length > 0) {
      setPaymentState({
        status: "partial_success",
        hash,
        ledger: horizon.ledger,
        onChain: false,
        message: onChainError ?? "On-chain recording failed.",
      });
      return;
    }

    setPaymentState({
      status: "success",
      hash,
      ledger: horizon.ledger,
      onChain,
    });
    toastSuccess("Settlement confirmed!", "Payment verified and recorded.");
  };

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
            {formatXLM(payment.amount)}{" "}
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
            onRetryOnChain={pendingOnChain && pendingOnChain.length > 0 ? retryOnChainRecord : undefined}
            onRetryRecording={
              paymentState.status === "pending_confirmation"
                ? () => checkPendingConfirmation(paymentState.hash)
                : pendingShares && pendingShares.shares.length > 0
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

      {!isDone && paymentState.status === "idle" && publicKey && publicKey !== payment.fromWallet && (
        <p className="text-[10px] text-[#AAA] pl-1">
          Connect {payment.from}&apos;s wallet to pay
        </p>
      )}
    </motion.div>
  );
}

export function SettlementSummary({ trip, expenses, onChainEvents = [] }: SettlementSummaryProps) {
  const memberEvents     = useMemo(() => filterMemberEvents(expenses, onChainEvents), [expenses, onChainEvents]);
  const rawDebts         = useMemo(() => deriveRawDebts(expenses, memberEvents), [expenses, memberEvents]);
  const unverifiedClaims = useMemo(() => deriveUnverifiedClaims(expenses, memberEvents), [expenses, memberEvents]);
  const eventCounts      = useMemo(() => ({
    attested: memberEvents.filter((event) => event.attested === true).length,
    selfReported: memberEvents.filter((event) => event.attested !== true).length,
  }), [memberEvents]);
  const netPayments      = useMemo(() => computeNetPayments(rawDebts), [rawDebts]);

  if (netPayments.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center rounded-xl border border-dashed border-[#D0D0D0]">
        <Scale size={20} className="text-[#B9FF66]" />
        <p className="text-sm font-semibold text-[#0F0F14]">All settled up!</p>
        <p className="text-xs text-[#AAA]">No outstanding balances in this trip.</p>
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

      {netPayments.map((p, i) => (
        <NetPaymentRow
          key={`${p.fromId}-${p.toId}-${i}`}
          payment={p}
          index={i}
          tripId={trip.id}
          expenses={expenses}
          unverifiedClaimCount={
            p.fromWallet && p.toWallet
              ? unverifiedClaims.get(`${p.fromWallet.toLowerCase()}-${p.toWallet.toLowerCase()}`)
              : undefined
          }
        />
      ))}
    </div>
  );
}
