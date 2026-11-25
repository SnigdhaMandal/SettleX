"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import {
  inspectSignedTransaction,
  isSubmissionIndeterminate,
  submitSignedTransaction,
} from "@/lib/stellar/submitTransaction";
import { recordPaymentOnChain, checkIsPaid } from "@/lib/stellar/contract";
import { sameWallet, sharePaymentDenial } from "@/lib/payments/shareOwnership";
import { signXDR } from "@/lib/freighter";
import { shareMemo } from "@/lib/stellar/memo";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import {
  NETWORK_PASSPHRASE,
  STELLAR_EXPLORER,
  CONTRACT_ID,
  stellarNetworkLabel,
} from "@/lib/utils/constants";
import { formatXLM } from "@/lib/utils";
import { countMetric, reportError } from "@/lib/observability/logger";
import { userFacingMessage } from "@/lib/errors/userMessage";
import {
  checkTransactionOnHorizon,
  deletePendingPaymentRemote,
  fetchPendingPaymentsRemote,
  getPendingPayment,
  isPastValidity,
  listPendingPayments,
  mergePendingPayments,
  removePendingPaymentLocal,
  savePendingPaymentLocal,
  syncPendingPaymentRemote,
  type PendingPayment,
} from "@/lib/payments/pendingPayments";
import { normalizeTxHash, verifyQrSharePayment } from "@/lib/payments/qrReconcile";
import type { SplitShare } from "@/types/expense";

type OnChainStep = "simulating" | "signing" | "sending" | "confirming";

export type PaymentState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "recording"; step: OnChainStep }
  /** Reconciling a pending payment against Horizon / the database. */
  | { status: "verifying"; hash: string }
  /** Submitted, but Stellar has not confirmed it yet. Pay stays blocked. */
  | { status: "pending_confirmation"; hash: string; message: string }
  /** XLM moved, but the share could not be marked paid. Pay stays blocked. */
  | { status: "paid_unrecorded"; hash: string; ledger: number; onChain: boolean; message: string }
  | { status: "success"; hash: string; ledger: number; onChain: boolean }
  | { status: "partial_success"; hash: string; ledger: number; onChain: boolean; message: string }
  | { status: "error"; message: string };

interface UsePaymentOpts {
  expenseId: string;
}

interface PayShareParams {
  share: SplitShare;
  /** Display only; the memo is derived from the expense and member ids. */
  expenseTitle: string;
  payerWalletAddress: string;
  tripId?: string;
}

interface PendingOnChainRecord {
  /** Who sent the XLM: the share's owner, and the account that signs the record. */
  debtorPublicKey: string;
  tripId: string;
  expenseId: string;
  /** Who received it: the member who paid the bill. */
  creditorPublicKey: string;
  amountXlm: string;
  txHash: string;
  ledger: number;
}

type RecordOutcome = { ok: true } | { ok: false; message: string };

// Errors meaning the transfer is already recorded (share paid, or hash already used)
function isAlreadyRecorded(err: unknown): boolean {
  const message = (err as { message?: string })?.message ?? "";
  return /already marked as paid|already used on another/i.test(message);
}

const DO_NOT_PAY_AGAIN =
  "Your XLM transfer went through. Retry recording — do not pay again.";

export function usePayment({ expenseId }: UsePaymentOpts) {
  const {
    publicKey,
    refreshBalance,
    refreshNetwork,
    expectedNetwork,
    reconcile,
  } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();

  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  const [pendingOnChain, setPendingOnChain] = useState<PendingOnChainRecord | null>(null);
  const [pendingByMember, setPendingByMember] = useState<Record<string, PendingPayment>>({});
  const activePendingRef = useRef<PendingPayment | null>(null);
  const inFlightRef = useRef(false);

  // Pending-payment bookkeeping

  const persistPending = useCallback(async (entry: PendingPayment, awaitRemote: boolean) => {
    savePendingPaymentLocal(entry);
    activePendingRef.current = entry;
    setPendingByMember((prev) => ({ ...prev, [entry.memberId]: entry }));
    const remote = syncPendingPaymentRemote(entry);
    if (awaitRemote) await remote;
  }, []);

  const clearPending = useCallback((entry: PendingPayment) => {
    removePendingPaymentLocal(entry.payerWallet, entry.expenseId, entry.memberId, entry.txHash);
    if (activePendingRef.current?.txHash === entry.txHash) activePendingRef.current = null;
    setPendingByMember((prev) => {
      if (prev[entry.memberId]?.txHash !== entry.txHash) return prev;
      const next = { ...prev };
      delete next[entry.memberId];
      return next;
    });
    void deletePendingPaymentRemote(entry.payerWallet, entry.expenseId, entry.memberId, entry.txHash);
  }, []);

  const scheduleBalanceRefresh = useCallback(() => {
    setTimeout(() => refreshBalance(), 3000);
    setTimeout(() => refreshBalance(), 8000);
  }, [refreshBalance]);

  const recordShare = useCallback(async (entry: PendingPayment): Promise<RecordOutcome> => {
    try {
      await markSharePaid(entry.expenseId, entry.memberId, entry.txHash);
      return { ok: true };
    } catch (err) {
      if (isAlreadyRecorded(err)) return { ok: true };
      countMetric("payment.paid_unrecorded");
      reportError("payment.mark_share_paid_after_transfer_failed", err, {
        fields: { expenseId: entry.expenseId, txHash: entry.txHash },
      });
      return { ok: false, message: userFacingMessage(err).message };
    }
  }, [markSharePaid]);

  // Finish up once a landed transfer has been recorded in the DB
  const finishRecorded = useCallback((entry: PendingPayment, ledger: number, announce: boolean) => {
    clearPending(entry);

    if (CONTRACT_ID && entry.tripId && !entry.onChainRecorded) {
      const message = "Payment recorded. The on-chain contract record is still pending.";
      setPendingOnChain({
        debtorPublicKey: entry.payerWallet,
        tripId: entry.tripId,
        expenseId: entry.expenseId,
        creditorPublicKey: entry.destinationWallet,
        amountXlm: entry.amount,
        txHash: entry.txHash,
        ledger,
      });
      setPaymentState({ status: "partial_success", hash: entry.txHash, ledger, onChain: false, message });
      if (announce) toastInfo("Payment recorded", message);
      return;
    }

    setPaymentState({ status: "success", hash: entry.txHash, ledger, onChain: entry.onChainRecorded });
    if (announce) toastSuccess("Payment recorded", `TX: ${entry.txHash.slice(0, 12)}…`);
  }, [clearPending, toastInfo, toastSuccess]);

  // Check Horizon to see if the money actually moved, then reconcile
  const reconcilePending = useCallback(async (entry: PendingPayment, announce: boolean) => {
    activePendingRef.current = entry;
    setPaymentState({ status: "verifying", hash: entry.txHash });

    let current = entry;
    let ledger = entry.ledger ?? 0;

    if (entry.status === "signed") {
      const horizon = await checkTransactionOnHorizon(entry.txHash);

      if (horizon.state === "failed") {
        // Included in a ledger but failed: no XLM moved, so paying is safe again.
        clearPending(entry);
        setPaymentState({
          status: "error",
          message: "The earlier transfer failed on the Stellar network, so no XLM moved. You can pay again.",
        });
        return;
      }

      if (horizon.state === "not_found" && isPastValidity(entry)) {
        // Expired without landing: it can never be included now.
        clearPending(entry);
        setPaymentState(
          announce
            ? { status: "error", message: "The earlier transfer expired without being sent, so no XLM moved. You can pay again." }
            : { status: "idle" },
        );
        return;
      }

      if (horizon.state !== "confirmed") {
        setPaymentState({
          status: "pending_confirmation",
          hash: entry.txHash,
          message: horizon.state === "unknown"
            ? "Could not reach Stellar to confirm the earlier transfer. Check again shortly."
            : "Stellar has not confirmed the earlier transfer yet. Check again shortly.",
        });
        return;
      }

      ledger = horizon.ledger;
      current = { ...entry, status: "submitted", ledger };
      await persistPending(current, false);
    }

    const recorded = await recordShare(current);
    if (!recorded.ok) {
      setPaymentState({
        status: "paid_unrecorded",
        hash: current.txHash,
        ledger,
        onChain: current.onChainRecorded,
        message: recorded.message,
      });
      if (announce) toastError("Recording still failing", recorded.message);
      return;
    }

    finishRecorded(current, ledger, announce);
  }, [clearPending, finishRecorded, persistPending, recordShare, toastError]);

  // On load (and on wallet change), pick up pending payments left behind by a
  // reload, crash or another device, and reconcile them against Horizon.
  //
  // reconcilePending changes identity whenever the expense list does (it is
  // polled), so it is read through a ref: this must run once per wallet and
  // expense, not on every poll.
  const reconcileRef = useRef(reconcilePending);
  useEffect(() => {
    reconcileRef.current = reconcilePending;
  }, [reconcilePending]);
  const reconciledForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!publicKey) {
      setPendingByMember({});
      activePendingRef.current = null;
      reconciledForRef.current = null;
      return;
    }
    const key = `${publicKey}:${expenseId}`;
    if (reconciledForRef.current === key) return;
    reconciledForRef.current = key;

    let cancelled = false;
    // Block Pay immediately from the local copy; Horizon/DB checks follow.
    const local = listPendingPayments(publicKey, expenseId);
    setPendingByMember(Object.fromEntries(local.map((p) => [p.memberId, p])));

    void (async () => {
      const remote = await fetchPendingPaymentsRemote(publicKey, expenseId);
      if (cancelled) return;
      const merged = mergePendingPayments(local, remote);
      if (merged.length === 0) return;
      for (const entry of merged) savePendingPaymentLocal(entry);
      setPendingByMember(Object.fromEntries(merged.map((p) => [p.memberId, p])));
      for (const entry of merged) {
        if (cancelled) return;
        await reconcileRef.current(entry, false);
      }
    })();

    return () => {
      cancelled = true;
      // Allow a re-run (e.g. React strict-mode remount) to reconcile again.
      if (reconciledForRef.current === key) reconciledForRef.current = null;
    };
  }, [publicKey, expenseId]);

  // Public actions

  const reset = useCallback(() => {
    setPaymentState({ status: "idle" });
    setPendingOnChain(null);
  }, []);

  const hasCurrentPaymentNetwork = useCallback(async (action: "paying" | "retrying") => {
    const liveNetwork = await refreshNetwork();
    if (liveNetwork === expectedNetwork) return true;

    toastError(
      "Payment blocked",
      liveNetwork
        ? `Switch your wallet to ${stellarNetworkLabel(expectedNetwork)} before ${action}.`
        : `SettleX could not verify your wallet is on ${stellarNetworkLabel(expectedNetwork)}.`,
    );
    return false;
  }, [expectedNetwork, refreshNetwork, toastError]);

  const retryRecording = useCallback(async () => {
    const entry =
      activePendingRef.current ??
      Object.values(pendingByMember)[0] ??
      null;
    if (!entry || inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      await reconcilePending(entry, true);
    } finally {
      inFlightRef.current = false;
    }
  }, [pendingByMember, reconcilePending]);

  const retryOnChainRecord = useCallback(async () => {
    if (!pendingOnChain) return;
    // The record is signed by the debtor; another connected wallet cannot
    // (and must not) record this payment.
    if (!sameWallet(publicKey, pendingOnChain.debtorPublicKey)) {
      toastError("Wrong wallet", "Connect the wallet that sent this payment to record it on-chain.");
      return;
    }
    if (!(await hasCurrentPaymentNetwork("retrying"))) return;

    setPaymentState({ status: "recording", step: "simulating" });
    const contractResult = await recordPaymentOnChain({
      ...pendingOnChain,
      onStatus: (step) => setPaymentState({ status: "recording", step }),
    });

    if (!contractResult.success) {
      const msg = contractResult.error ?? "On-chain retry failed.";
      countMetric("payment.partial_success", { stage: "retry_record" });
      reportError("payment.onchain_retry_failed", msg, {
        fields: { expenseId: pendingOnChain.expenseId, txHash: pendingOnChain.txHash },
      });
      setPaymentState({
        status: "partial_success",
        hash: pendingOnChain.txHash,
        ledger: pendingOnChain.ledger,
        onChain: false,
        message: msg,
      });
      toastError("On-chain retry failed", msg);
      return;
    }

    setPendingOnChain(null);
    setPaymentState({
      status: "success",
      hash: pendingOnChain.txHash,
      ledger: contractResult.ledger ?? pendingOnChain.ledger,
      onChain: true,
    });
    toastSuccess("On-chain record recovered", "Payment is now confirmed in the contract.");
  }, [
    hasCurrentPaymentNetwork,
    pendingOnChain,
    publicKey,
    toastError,
    toastSuccess,
  ]);

  const payShare = useCallback(
    async ({ share, payerWalletAddress, tripId }: PayShareParams) => {
      if (inFlightRef.current) return;

      await reconcile();
      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Stellar wallet first.");
        return;
      }
      // Only the share's owner may pay it (Issue #208). The UI hides Pay for
      // other rows, but this is the rule that actually holds: a third party's
      // payment would be recorded against the wrong person and slip past the
      // on-chain duplicate guard, which is keyed by the share's wallet.
      const denial = sharePaymentDenial({
        share,
        connectedWallet: publicKey,
        creditorWallet: payerWalletAddress,
      });
      if (denial) {
        toastError("Payment blocked", denial);
        return;
      }
      // From here the sender, the share owner and the debtor are one account.
      const debtor = publicKey;
      const creditor = payerWalletAddress;
      if (share.paid) {
        toastInfo("Already paid", `${share.name}'s share is already marked as paid.`);
        return;
      }
      // Duplicate guard that works for every expense, with or without a
      // contract: a transfer for this share may already have moved.
      if (pendingByMember[share.memberId] || getPendingPayment(publicKey, expenseId, share.memberId)) {
        toastError(
          "Payment already sent",
          "A payment for this share is already in progress or waiting to be recorded. Retry recording instead of paying again.",
        );
        return;
      }
      if (!(await hasCurrentPaymentNetwork("paying"))) return;

      // Pre-flight: check if already settled on-chain before building the TX.
      // Keyed by the debtor, the same account record_payment records below.
      if (CONTRACT_ID) {
        const alreadyPaid = await checkIsPaid(debtor, expenseId, debtor);
        if (alreadyPaid.paid) {
          toastError(
            "Already settled on-chain",
            "This payment was already recorded on Stellar. No action needed.",
          );
          return;
        }
      }

      inFlightRef.current = true;
      let pending: PendingPayment | null = null;

      try {
        // ── 1. Build, sign, persist, submit ──────────────────────────────────
        let result: { hash: string; ledger: number };
        try {
          setPaymentState({ status: "building" });
          const { xdr } = await buildPaymentTransaction({
            sourcePublicKey:      debtor,
            destinationPublicKey: creditor,
            amount:               share.amount,
            memo:                 shareMemo(expenseId, share.memberId),
          });

          setPaymentState({ status: "signing" });
          toastInfo("Waiting for wallet signature…", "Review and confirm the transaction.");
          const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE, debtor);

          // The hash is fixed once signed. Persist it before anything can move
          // money, so a crash or DB failure after submission is recoverable.
          const signed = inspectSignedTransaction(signedXDR);
          pending = {
            expenseId,
            memberId: share.memberId,
            txHash: signed.hash,
            payerWallet: debtor,
            destinationWallet: creditor,
            amount: share.amount,
            tripId: tripId ?? null,
            status: "signed",
            ledger: null,
            validUntil: signed.validUntil,
            onChainRecorded: false,
            createdAt: new Date().toISOString(),
          };
          await persistPending(pending, true);

          setPaymentState({ status: "submitting" });
          result = await submitSignedTransaction(signedXDR);
        } catch (err) {
          if (pending && isSubmissionIndeterminate(err)) {
            // The transfer may still land. Keep the entry so Pay stays blocked
            // until Horizon tells us either way.
            countMetric("payment.indeterminate");
            reportError("payment.submission_indeterminate", err, {
              fields: { expenseId, tripId, txHash: pending.txHash },
            });
            setPaymentState({
              status: "pending_confirmation",
              hash: pending.txHash,
              message: userFacingMessage(err).message,
            });
            toastInfo(
              "Payment awaiting confirmation",
              "Stellar has not confirmed the transfer yet. Don't pay again — check again shortly.",
            );
            return;
          }
          // Definitive failure: the transfer did not happen.
          if (pending) clearPending(pending);
          throw err;
        }

        // ── 2. Money has moved. Nothing below may report "failed". ───────────
        pending = { ...pending!, txHash: result.hash || pending!.txHash, status: "submitted", ledger: result.ledger };
        await persistPending(pending, false);

        let onChain = false;
        let onChainError: string | null = null;
        if (CONTRACT_ID && tripId) {
          setPaymentState({ status: "recording", step: "simulating" });
          const contractResult = await recordPaymentOnChain({
            debtorPublicKey:   debtor,
            tripId,
            expenseId,
            creditorPublicKey: creditor,
            amountXlm:      share.amount,
            txHash:         pending.txHash,
            onStatus:       (step) => setPaymentState({ status: "recording", step }),
          });

          if (contractResult.success) {
            onChain = true;
            pending = { ...pending, onChainRecorded: true };
            await persistPending(pending, false);
          } else {
            onChainError = contractResult.error ?? "On-chain recording failed.";
            setPendingOnChain({
              debtorPublicKey: debtor,
              tripId,
              expenseId,
              creditorPublicKey: creditor,
              amountXlm: share.amount,
              txHash: pending.txHash,
              ledger: result.ledger,
            });
          }
        }

        // Sync the database so the app reflects financial reality.
        const recorded = await recordShare(pending);
        if (!recorded.ok) {
          setPaymentState({
            status: "paid_unrecorded",
            hash: pending.txHash,
            ledger: result.ledger,
            onChain,
            message: recorded.message,
          });
          toastInfo("Payment sent — recording pending", DO_NOT_PAY_AGAIN);
          scheduleBalanceRefresh();
          return;
        }

        clearPending(pending);

        if (onChainError) {
          // Money moved but the contract has no record of it — the divergence
          // that most needs counting, and the exact number the issue asks for.
          countMetric("payment.partial_success", { stage: "record" });
          reportError("payment.onchain_record_failed", onChainError, {
            fields: { expenseId, tripId, txHash: pending.txHash, ledger: result.ledger },
          });
          setPaymentState({
            status: "partial_success",
            hash: pending.txHash,
            ledger: result.ledger,
            onChain: false,
            message: onChainError,
          });
          toastInfo(
            "Payment sent, on-chain record pending",
            "XLM transfer succeeded. Use retry to record it on-chain.",
          );
          scheduleBalanceRefresh();
          return;
        }

        // Counted so partial_success has a denominator — a rate, not a raw count.
        countMetric("payment.success", { onChain });
        setPaymentState({ status: "success", hash: pending.txHash, ledger: result.ledger, onChain });
        toastSuccess(
          `Paid ${formatXLM(share.amount)} XLM to ${share.name}`,
          onChain
            ? `TX: ${pending.txHash.slice(0, 12)}… · Recorded on-chain ✓`
            : `TX: ${pending.txHash.slice(0, 12)}…`,
        );

        scheduleBalanceRefresh();
      } catch (err) {
        // Only reachable before any XLM moved (build, sign or a definitive
        // submission failure).
        const message    = err instanceof Error ? err.message : "Payment failed. Please try again.";
        const isRejected = /reject|denied|cancel/i.test(message.toLowerCase());
        // Same reason as app/error.tsx: a failure mid-payment can be a raw
        // PostgREST or RPC error, and this string is rendered straight into the
        // payment panel. Vetted messages (wallet and contract errors are written
        // for users) still show; anything internal becomes the generic line.
        const display    = isRejected
          ? "Transaction cancelled in wallet."
          : userFacingMessage(err).message;

        // A user declining in their wallet is normal traffic, not a fault; it is
        // counted but not reported, so it cannot drown the real failures.
        if (isRejected) {
          countMetric("payment.rejected_in_wallet");
        } else {
          countMetric("payment.failed");
          reportError("payment.failed", err, { fields: { expenseId, tripId } });
        }

        setPaymentState({ status: "error", message: display });
        toastError("Payment failed", display);
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      reconcile,
      publicKey,
      pendingByMember,
      hasCurrentPaymentNetwork,
      expenseId,
      persistPending,
      clearPending,
      recordShare,
      scheduleBalanceRefresh,
      toastSuccess,
      toastError,
      toastInfo,
    ],
  );

  // "I paid via QR": user pastes a TX hash from their external wallet app,
  // we verify it against Horizon and then record it like a normal payment.
  const reconcileQrPayment = useCallback(
    async ({
      share,
      payerWalletAddress,
      tripId,
      txHash: rawHash,
    }: {
      share: SplitShare;
      payerWalletAddress: string;
      tripId?: string;
      txHash: string;
    }): Promise<boolean> => {
      if (inFlightRef.current) return false;
      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Stellar wallet first.");
        return false;
      }
      const denial = sharePaymentDenial({
        share,
        connectedWallet: publicKey,
        creditorWallet: payerWalletAddress,
      });
      if (denial) {
        toastError("Cannot record payment", denial);
        return false;
      }
      if (share.paid) {
        toastInfo("Already paid", `${share.name}'s share is already marked as paid.`);
        return false;
      }
      const txHash = normalizeTxHash(rawHash);
      if (!txHash) {
        toastError("Invalid transaction hash", "Paste the 64-character hash shown by your wallet.");
        return false;
      }
      const existing = pendingByMember[share.memberId] ?? getPendingPayment(publicKey, expenseId, share.memberId);
      if (existing && existing.txHash !== txHash) {
        toastError(
          "Payment already sent",
          "Another payment for this share is waiting to be recorded. Retry recording it instead.",
        );
        return false;
      }

      inFlightRef.current = true;
      try {
        setPaymentState({ status: "verifying", hash: txHash });
        const verified = await verifyQrSharePayment({
          txHash,
          debtorWallet: publicKey,
          creditorWallet: payerWalletAddress,
          amount: share.amount,
          memo: shareMemo(expenseId, share.memberId),
        });
        if (!verified.ok) {
          setPaymentState({ status: "error", message: verified.reason });
          toastError("Payment not verified", verified.reason);
          return false;
        }

        // Verified on Horizon: the money moved. Persist before recording, the
        // same as an in-app payment after submission.
        let entry: PendingPayment = {
          expenseId,
          memberId: share.memberId,
          txHash,
          payerWallet: publicKey,
          destinationWallet: payerWalletAddress,
          amount: share.amount,
          tripId: tripId ?? null,
          status: "submitted",
          ledger: verified.ledger,
          validUntil: null,
          onChainRecorded: false,
          createdAt: new Date().toISOString(),
        };
        await persistPending(entry, false);

        if (CONTRACT_ID && tripId) {
          setPaymentState({ status: "recording", step: "simulating" });
          const contractResult = await recordPaymentOnChain({
            debtorPublicKey: publicKey,
            tripId,
            expenseId,
            creditorPublicKey: payerWalletAddress,
            amountXlm: share.amount,
            txHash,
            onStatus: (step) => setPaymentState({ status: "recording", step }),
          });
          if (contractResult.success) {
            entry = { ...entry, onChainRecorded: true };
            await persistPending(entry, false);
          }
        }

        const recorded = await recordShare(entry);
        if (!recorded.ok) {
          setPaymentState({
            status: "paid_unrecorded",
            hash: txHash,
            ledger: verified.ledger,
            onChain: entry.onChainRecorded,
            message: recorded.message,
          });
          toastInfo("Payment verified — recording pending", DO_NOT_PAY_AGAIN);
          return false;
        }

        countMetric("payment.qr_reconciled");
        finishRecorded(entry, verified.ledger, true);
        scheduleBalanceRefresh();
        return true;
      } finally {
        inFlightRef.current = false;
      }
    },
    [
      publicKey,
      pendingByMember,
      expenseId,
      persistPending,
      recordShare,
      finishRecorded,
      scheduleBalanceRefresh,
      toastError,
      toastInfo,
    ],
  );

  const pendingShareIds = Object.keys(pendingByMember);
  const hashOf = (state: PaymentState): string | null =>
    "hash" in state ? state.hash : null;
  const currentHash = hashOf(paymentState);

  return {
    paymentState,
    payShare,
    reconcileQrPayment,
    reset,
    retryOnChainRecord,
    retryRecording,
    pendingShareIds,
    hasPendingPayment: (memberId: string) => memberId in pendingByMember,
    isIdle:    paymentState.status === "idle",
    isLoading: ["building", "signing", "submitting", "recording", "verifying"].includes(paymentState.status),
    isSuccess: paymentState.status === "success",
    isError:   paymentState.status === "error",
    txHash:    currentHash,
    onChain:   "onChain" in paymentState ? paymentState.onChain : false,
    explorerUrl: currentHash ? `${STELLAR_EXPLORER}/tx/${currentHash}` : null,
  };
}
