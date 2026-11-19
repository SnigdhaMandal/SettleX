"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle2, AlertTriangle, ExternalLink, Layers, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { TransactionHash } from "@/components/payment/TransactionHash";
import {
  HORIZON_URL,
  STELLAR_EXPLORER,
  STELLAR_NETWORK,
  stellarNetworkLabel,
} from "@/lib/utils/constants";
import { cn, formatAddress, formatXLM } from "@/lib/utils";

export interface ReceiptModalProps {
  open: boolean;
  onClose: () => void;
  txHash: string;
  memo?: string;
  /** XLM amount string, e.g. "300.0000000" */
  amount: string;
  recipientName: string;
  shareOwner?: string;
  destinationWallet?: string;
  ledger?: number;
  paidBy?: string;
  markedAt?: string;
  manual?: boolean;
}

export function ReceiptModal({
  open,
  onClose,
  txHash,
  memo,
  amount,
  recipientName,
  shareOwner,
  destinationWallet,
  ledger,
  paidBy,
  markedAt,
  manual,
}: ReceiptModalProps) {
  const isHex64 = Boolean(txHash && /^[0-9a-fA-F]{64}$/.test(txHash));
  const [loading, setLoading] = useState(isHex64);
  const [txDetails, setTxDetails] = useState<{
    loaded: boolean;
    exists: boolean;
    successful: boolean;
    sourceMatches: boolean;
    transactionMatches: boolean;
    memo?: string;
    hasMemo: boolean;
    amount?: string;
    sourceAccount?: string;
    destination?: string;
    ledger?: number;
  }>({
    loaded: !isHex64,
    exists: false,
    successful: false,
    sourceMatches: false,
    transactionMatches: false,
    hasMemo: false,
  });

  useEffect(() => {
    if (!open || !txHash) {
      return;
    }

    let isCancelled = false;

    // Fast path: invalid transaction hash cannot exist on Horizon
    if (!/^[0-9a-fA-F]{64}$/.test(txHash)) {
      setLoading(false);
      setTxDetails({
        loaded: true,
        exists: false,
        successful: false,
        sourceMatches: false,
        transactionMatches: false,
        hasMemo: false,
      });
      return;
    }

    setLoading(true);

    async function fetchTransaction() {
      try {
        const normalizedHash = txHash.toLowerCase();
        const [txRes, opsRes] = await Promise.all([
          fetch(`${HORIZON_URL}/transactions/${normalizedHash}`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
          }),
          fetch(`${HORIZON_URL}/transactions/${normalizedHash}/operations`, {
            cache: "no-store",
            headers: { Accept: "application/json" },
          }).catch(() => null),
        ]);

        if (isCancelled) return;

        if (!txRes.ok) {
          setTxDetails({
            loaded: true,
            exists: false,
            successful: false,
            sourceMatches: false,
            transactionMatches: false,
            hasMemo: false,
          });
          setLoading(false);
          return;
        }

        const txData = await txRes.json();
        const successful = txData.successful !== false;
        const ledgerVal = txData.ledger_attr ?? txData.ledger;
        const memoVal = txData.memo ?? undefined;
        const hasMemo = Boolean(txData.memo && txData.memo_type !== "none");
        const sourceAccount = txData.source_account;

        let destination: string | undefined;
        let onChainAmount: string | undefined;
        let opSource: string | undefined;

        if (opsRes && opsRes.ok) {
          const opsData = await opsRes.json();
          const records = opsData._embedded?.records || [];
          const paymentOp = records.find(
            (op: any) =>
              op.type === "payment" ||
              op.type === "create_account" ||
              Boolean(op.amount) ||
              Boolean(op.starting_balance)
          );
          if (paymentOp) {
            destination = paymentOp.to || paymentOp.into || paymentOp.account;
            onChainAmount = paymentOp.amount || paymentOp.starting_balance;
            opSource = paymentOp.from || paymentOp.source_account || paymentOp.funder;
          }
        }

        const effectiveSource = opSource || sourceAccount;
        const targetShareOwner = shareOwner?.toUpperCase();
        const sourceMatches = Boolean(
          targetShareOwner &&
          (sourceAccount?.toUpperCase() === targetShareOwner ||
           effectiveSource?.toUpperCase() === targetShareOwner)
        );

        const destMatches =
          !destinationWallet ||
          (Boolean(destination) &&
           destination!.toUpperCase() === destinationWallet.toUpperCase());

        const amountMatches =
          !amount ||
          !onChainAmount ||
          Number(onChainAmount) === Number(amount);

        const transactionMatches = Boolean(successful && destMatches && amountMatches);

        setTxDetails({
          loaded: true,
          exists: true,
          successful,
          sourceMatches,
          transactionMatches,
          memo: memoVal,
          hasMemo,
          amount: onChainAmount,
          sourceAccount: effectiveSource || sourceAccount,
          destination,
          ledger: typeof ledgerVal === "number" ? ledgerVal : undefined,
        });
      } catch {
        if (!isCancelled) {
          setTxDetails({
            loaded: true,
            exists: false,
            successful: false,
            sourceMatches: false,
            transactionMatches: false,
            hasMemo: false,
          });
        }
      } finally {
        if (!isCancelled) {
          setLoading(false);
        }
      }
    }

    fetchTransaction();

    return () => {
      isCancelled = true;
    };
  }, [open, txHash, shareOwner, destinationWallet, amount]);

  const explorerUrl = `${STELLAR_EXPLORER}/tx/${txHash}`;
  const networkName = stellarNetworkLabel(STELLAR_NETWORK);

  const isVerified =
    txDetails.loaded &&
    txDetails.exists &&
    txDetails.successful &&
    txDetails.sourceMatches &&
    txDetails.transactionMatches;

  const displaySource = txDetails.sourceAccount;
  const displayDestination = txDetails.destination || (isVerified ? destinationWallet : undefined);
  const displayAmount = formatXLM(txDetails.amount || amount);
  const displayLedger = txDetails.ledger ?? ledger;

  let displayMemo = "—";
  if (txDetails.loaded) {
    if (txDetails.hasMemo && txDetails.memo) {
      displayMemo = txDetails.memo;
    } else if (txDetails.exists) {
      displayMemo = "None";
    } else if (memo) {
      displayMemo = memo;
    }
  } else if (memo) {
    displayMemo = memo;
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Payment Receipt"
      size="sm"
    >
      {/* ── Status badge ── */}
      {loading ? (
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-14 h-14 rounded-full bg-[#F5F5F5] flex items-center justify-center">
            <Loader2 size={32} className="text-[#888] animate-spin" />
          </div>
          <p className="text-xl font-bold text-[#0F0F14]">Verifying on Stellar...</p>
          <p className="text-sm text-[#888]">Checking transaction on {networkName}</p>
        </div>
      ) : isVerified ? (
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-14 h-14 rounded-full bg-[#B9FF66]/20 flex items-center justify-center">
            <CheckCircle2 size={32} className="text-[#2D6600]" />
          </div>
          <p className="text-xl font-bold text-[#0F0F14]">Payment Confirmed</p>
          <p className="text-sm text-[#888]">Successfully sent on Stellar {networkName}</p>
          <p className="text-[11px] text-[#AAA] text-center leading-relaxed max-w-[17rem]">
            Verify the transaction on Stellar Expert below. The in-app settlement
            record is self-attested and is not itself proof of payment.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2 mb-6">
          <div className="w-14 h-14 rounded-full bg-[#FEF3C7] flex items-center justify-center">
            <AlertTriangle size={32} className="text-[#D97706]" />
          </div>
          <p className="text-xl font-bold text-[#0F0F14] text-center">
            Marked paid by creator — not verified
          </p>
          <p className="text-sm text-[#888] text-center">
            {!txDetails.exists
              ? `Transaction not found on Stellar ${networkName}`
              : !txDetails.sourceMatches
              ? `Transaction source does not match share owner`
              : `Transaction details do not match on Stellar ${networkName}`}
          </p>
          <p className="text-[11px] text-[#AAA] text-center leading-relaxed max-w-[17rem]">
            Verify the transaction on Stellar Expert below. The in-app settlement
            record is self-attested and is not itself proof of payment.
          </p>
        </div>
      )}

      {/* ── Summary rows ── */}
      <dl className="space-y-2 mb-5">
        <ReceiptRow label="Recipient" value={recipientName} />
        {displaySource && (
          <ReceiptRow
            label="Source"
            value={
              <a
                href={`${STELLAR_EXPLORER}/account/${displaySource}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-[#0F0F14] hover:underline inline-flex items-center gap-1"
                title={displaySource}
              >
                {formatAddress(displaySource, 6)}
                <ExternalLink size={10} className="opacity-60" />
              </a>
            }
            hint="Account that submitted payment"
          />
        )}
        {displayDestination && (
          <ReceiptRow
            label="Destination"
            value={
              <a
                href={`${STELLAR_EXPLORER}/account/${displayDestination}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-[#0F0F14] hover:underline inline-flex items-center gap-1"
                title={displayDestination}
              >
                {formatAddress(displayDestination, 6)}
                <ExternalLink size={10} className="opacity-60" />
              </a>
            }
            hint="Recipient Stellar account"
          />
        )}
        <ReceiptRow
          label="Amount"
          value={
            <span className="font-bold text-[#B9FF66] bg-[#0F0F14] px-2 py-0.5 rounded text-sm">
              {displayAmount} XLM
            </span>
          }
        />
        <ReceiptRow
          label="Memo"
          value={
            <span className="font-mono text-xs break-all">{displayMemo}</span>
          }
          hint={txDetails.hasMemo ? "Stored on-chain with the transaction" : undefined}
        />
        {displayLedger !== undefined && (
          <ReceiptRow label="Ledger" value={`#${displayLedger}`} />
        )}
        {paidBy && (
          <ReceiptRow
            label="Marked Paid By"
            value={
              <a
                href={`${STELLAR_EXPLORER}/account/${paidBy}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-xs text-[#0F0F14] hover:underline inline-flex items-center gap-1"
                title={paidBy}
              >
                {formatAddress(paidBy, 6)}
                <ExternalLink size={10} className="opacity-60" />
              </a>
            }
          />
        )}
        {markedAt && (
          <ReceiptRow
            label="Marked At"
            value={
              <span className="text-xs text-[#555]">
                {new Date(markedAt).toLocaleString()}
              </span>
            }
          />
        )}
        {manual && (
          <ReceiptRow
            label="Payment Type"
            value={
              <span className="text-xs font-semibold text-[#D97706] bg-[#FEF3C7] border border-[#FDE68A] px-2 py-0.5 rounded">
                Manual creator override
              </span>
            }
            hint="Recorded directly by expense creator rather than detected from recipient wallet"
          />
        )}
      </dl>

      {/* ── TX hash ── */}
      <div className="p-3 bg-[#F6F6F6] rounded-xl mb-5">
        <p className="text-[10px] font-semibold text-[#AAA] uppercase tracking-wide mb-1.5">
          Transaction Hash
        </p>
        <TransactionHash hash={txHash} />
      </div>

      {/* ── Stellar Expert link ── */}
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex items-center justify-center gap-2 w-full py-2.5 rounded-xl",
          "bg-[#0F0F14] text-white text-sm font-semibold",
          "hover:bg-[#1a1a24] transition-colors"
        )}
      >
        <Layers size={14} />
        View on Stellar Expert
        <ExternalLink size={12} className="opacity-60" />
      </a>
    </Modal>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function ReceiptRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <dt className="text-xs font-semibold text-[#888]">{label}</dt>
        {hint && <p className="text-[10px] text-[#BBB]">{hint}</p>}
      </div>
      <dd className="text-sm text-[#0F0F14] text-right">{value}</dd>
    </div>
  );
}
