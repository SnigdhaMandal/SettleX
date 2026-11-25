"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, ReceiptIcon } from "lucide-react";
import { formatAddress, formatXLM, cn } from "@/lib/utils";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import { PayButton } from "@/components/payment/PayButton";
import { QRToggle } from "@/components/payment/QRCodeDisplay";
import { ReceiptModal } from "@/components/expenses/ReceiptModal";
import { useWallet } from "@/hooks/useWallet";
import { shareMemo } from "@/lib/stellar/memo";
import { canWalletPayShare } from "@/lib/payments/shareOwnership";
import type { SplitShare } from "@/types/expense";
import type { NetSettledReason } from "@/lib/settlement/netBalance";

interface PaymentRowProps {
  share: SplitShare;
  expenseId?: string; // needed to build the QR payment memo
  index: number;
  expenseTitle?: string;
  onPay?: (share: SplitShare) => void;
  isPaying?: boolean;
  hasPendingPayment?: boolean; // disables Pay if a transfer might already be in flight
  netSettled?: NetSettledReason; // set when trip netting covers this share ("net-transfer" | "offset"), hiding Pay and QR
  connectedWalletAddress?: string | null; // Pay and QR only show when connected wallet owns this share
  payerWalletAddress?: string; // creditor's wallet (where payments go)
  onReconcileQr?: (share: SplitShare, txHash: string) => Promise<boolean>; // records a QR payment after Horizon check
}

// Paste-the-hash form for QR payments
function QrHashForm({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (txHash: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = /^[0-9a-fA-F]{64}$/.test(hash.trim());

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[11px] font-semibold text-[#888] hover:text-[#0F0F14] underline-offset-2 hover:underline"
      >
        I paid via QR — paste the transaction hash
      </button>
    );
  }

  return (
    <form
      className="flex flex-col sm:flex-row gap-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid || busy) return;
        setBusy(true);
        try {
          if (await onSubmit(hash.trim())) {
            setHash("");
            setOpen(false);
          }
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="sr-only" htmlFor="qr-tx-hash">Transaction hash</label>
      <input
        id="qr-tx-hash"
        value={hash}
        onChange={(e) => setHash(e.target.value)}
        placeholder="64-character transaction hash"
        spellCheck={false}
        autoComplete="off"
        className="flex-1 min-w-0 text-[11px] font-mono px-2 py-1.5 rounded-lg border border-[#E5E5E5] focus:outline-none focus:border-[#0F0F14]"
      />
      <button
        type="submit"
        disabled={!valid || busy || disabled}
        className="text-[11px] font-bold px-3 py-1.5 rounded-lg bg-[#0F0F14] text-[#B9FF66] disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? "Checking…" : "Verify & record"}
      </button>
    </form>
  );
}

export function PaymentRow({
  share,
  expenseId,
  index,
  onPay,
  isPaying = false,
  hasPendingPayment = false,
  netSettled,
  connectedWalletAddress,
  payerWalletAddress,
  onReconcileQr,
}: PaymentRowProps) {
  const [showReceipt, setShowReceipt] = useState(false);
  const { isNetworkCompatible } = useWallet();
  const explorerUrl = share.walletAddress
    ? `${STELLAR_EXPLORER}/account/${share.walletAddress}`
    : null;

  // Match the in-app Pay memo so QR payments reconcile cleanly; unsaved previews don't have an ID yet
  const memo = expenseId ? shareMemo(expenseId, share.memberId) : undefined;

  // Only the share's own wallet can pay it — never a third party or the bill payer (Issue #208)
  const isMyRow = canWalletPayShare({
    share,
    connectedWallet: connectedWalletAddress,
    creditorWallet: payerWalletAddress,
  });

  const settled = share.paid || Boolean(netSettled);

  // Someone other than the share owner marked this as paid
  const isMarkedByOther = Boolean(
    share.paid &&
      share.paidBy &&
      (!share.walletAddress ||
        share.paidBy.toUpperCase() !== share.walletAddress.toUpperCase())
  );

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.05, duration: 0.25 }}
        className={cn(
          "flex flex-col gap-2 px-4 py-3 rounded-xl border transition-all",
          settled
            ? "bg-[#F0FFDB] border-[#B9FF66]/40"
            : "bg-white border-[#E5E5E5] hover:border-[#D0D0D0]"
        )}
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold",
                settled
                  ? "bg-[#B9FF66] text-[#0F0F14]"
                  : "bg-[#F0F0F0] text-[#555]"
              )}
            >
              {share.name.charAt(0).toUpperCase()}
            </div>

            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#0F0F14] truncate">
                {share.name}
              </p>
              {share.walletAddress && !settled && (
                <a
                  href={explorerUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#AAA] hover:text-[#555] transition-colors max-w-full"
                  onClick={(e) => e.stopPropagation()}
                >
                  {formatAddress(share.walletAddress, 4)}
                  <ExternalLink size={9} />
                </a>
              )}
              {share.paid && isMarkedByOther && share.paidBy && (
                <p
                  className="text-[11px] text-[#666] flex items-center gap-1 mt-0.5"
                  title={
                    share.markedAt
                      ? `Marked at ${new Date(share.markedAt).toLocaleString()} by ${share.paidBy}`
                      : `Marked by ${share.paidBy}`
                  }
                >
                  <span>marked paid by</span>
                  <a
                    href={`${STELLAR_EXPLORER}/account/${share.paidBy}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[#0F0F14] hover:underline inline-flex items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                    title={share.paidBy}
                  >
                    {formatAddress(share.paidBy, 4)}
                    <ExternalLink size={9} />
                  </a>
                </p>
              )}
              {share.paid && share.txHash && (
                <button
                  onClick={() => setShowReceipt(true)}
                  className="flex items-center gap-1 text-[11px] text-[#2D6600] hover:underline"
                >
                  <ReceiptIcon size={9} />
                  View receipt
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-2">
            <span className="text-sm font-bold text-[#0F0F14]">
              {formatXLM(share.amount)}{" "}
              <span className="text-[10px] font-normal text-[#888]">XLM</span>
            </span>

            {share.paid ? (
              <div className="flex items-center gap-1.5">
                {share.manual && (
                  <span className="inline-flex items-center text-[10px] font-semibold text-[#D97706] bg-[#FEF3C7] border border-[#FDE68A] px-1.5 py-0.5 rounded">
                    Manual
                  </span>
                )}
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#B9FF66]/30 text-[#2D6600] rounded-full">
                  ✓ Paid
                </span>
              </div>
            ) : netSettled ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#B9FF66]/30 text-[#2D6600] rounded-full"
                title={
                  netSettled === "net-transfer"
                    ? "Covered by a recorded settle-up transfer for this trip"
                    : "Cancelled out by what you are owed in this trip; no transfer needed"
                }
              >
                {netSettled === "net-transfer" ? "✓ Settled via net transfer" : "✓ Offset by netting"}
              </span>
            ) : isMyRow ? (
              <PayButton
                amount={share.amount}
                recipientName={share.name}
                onClick={() => onPay?.(share)}
                isLoading={isPaying}
                disabled={!share.walletAddress || !onPay || !isNetworkCompatible || hasPendingPayment}
                label={hasPendingPayment ? "Payment pending" : undefined}
                size="sm"
              />
            ) : (
              <span className="inline-flex items-center text-[10px] font-medium text-[#AAA] px-2 py-0.5 bg-[#F5F5F5] rounded-full">
                Awaiting
              </span>
            )}
          </div>
        </div>

        {/* QR sends funds to the bill payer, not the share owner */}
        {!share.paid && !hasPendingPayment && isMyRow && payerWalletAddress && memo && (
          <div className="pl-11 flex flex-col gap-2">
            <QRToggle
              data={{ destination: payerWalletAddress, amount: share.amount, memo }}
            />
            {onReconcileQr && (
              <QrHashForm
                disabled={isPaying || !isNetworkCompatible}
                onSubmit={(txHash) => onReconcileQr(share, txHash)}
              />
            )}
          </div>
        )}
      </motion.div>

      {share.paid && share.txHash && (
        <ReceiptModal
          open={showReceipt}
          onClose={() => setShowReceipt(false)}
          txHash={share.txHash}
          expectedMemo={memo}
          amount={share.amount}
          recipientName={share.name}
          shareOwner={share.walletAddress}
          destinationWallet={payerWalletAddress}
          paidBy={share.paidBy}
          markedAt={share.markedAt}
          manual={share.manual}
        />
      )}
    </>
  );
}
