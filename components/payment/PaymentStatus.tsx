"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, Loader2, Database } from "lucide-react";
import { TransactionHash } from "./TransactionHash";
import type { PaymentState } from "@/hooks/usePayment";
import { cn } from "@/lib/utils";

interface PaymentStatusProps {
  state: PaymentState;
  onReset?: () => void;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  building:   "Building transaction…",
  signing:    "Waiting for wallet signature…",
  submitting: "Submitting to Stellar network…",
  recording:  "Recording payment on-chain…",
};

export function PaymentStatus({ state, onReset, className }: PaymentStatusProps) {
  const isLoadingState =
    state.status === "building" ||
    state.status === "signing" ||
    state.status === "submitting" ||
    state.status === "recording";

  return (
    <AnimatePresence mode="wait">
      {state.status === "idle" ? null : (
        <motion.div
          key={state.status}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={cn("rounded-xl border p-4", className, {
            "bg-[#F8FFF0] border-[#B9FF66]/40": state.status === "success",
            "bg-red-50 border-red-200":          state.status === "error",
            "bg-[#F8F8F8] border-[#E5E5E5]":    isLoadingState,
          })}
        >
          {/* Loading states: building / signing / submitting / recording */}
          {isLoadingState && (
            <div className="flex items-center gap-3">
              {state.status === "recording" ? (
                <Database size={16} className="animate-pulse text-[#888] shrink-0" />
              ) : (
                <Loader2 size={16} className="animate-spin text-[#888] shrink-0" />
              )}
              <div>
                <p className="text-sm font-medium text-[#555]">
                  {STATUS_LABELS[state.status]}
                </p>
                {state.status === "recording" && (
                  <p className="text-[11px] text-[#AAA] mt-0.5">
                    Storing settlement proof in the Soroban contract…
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Success */}
          {state.status === "success" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <CheckCircle2 size={16} className="text-[#2D6600] shrink-0" />
                <p className="text-sm font-bold text-[#2D6600]">Payment successful!</p>
                {state.onChain && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-[#B9FF66]/30 text-[#2D6600]">
                    <Database size={9} />
                    On-chain
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[#888]">TX:</span>
                <TransactionHash hash={state.hash} compact />
              </div>
              {onReset && (
                <button
                  onClick={onReset}
                  className="text-xs text-[#AAA] hover:text-[#555] transition-colors mt-1"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {/* Error */}
          {state.status === "error" && (
            <div className="flex items-start gap-2">
              <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-600">Payment failed</p>
                <p className="text-xs text-red-500 mt-0.5">{state.message}</p>
                {onReset && (
                  <button
                    onClick={onReset}
                    className="text-xs text-red-400 hover:text-red-600 underline mt-1 transition-colors"
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
