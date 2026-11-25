"use client";

import { useEffect, useState } from "react";
import { newCorrelationId, reportError } from "@/lib/observability/logger";
import { userFacingMessage } from "@/lib/errors/userMessage";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [correlationId] = useState(newCorrelationId); // matches UI ref to logged error

  // don't surface raw PostgREST/internal errors to the user
  const { message, wasSuppressed } = userFacingMessage(error);

  useEffect(() => {
    // always report the full error; digest ties this to the server log
    reportError("ui.render_error", error, {
      correlationId,
      fields: {
        digest: error.digest,
        boundary: "app/error",
        messageSuppressed: wasSuppressed, // flag so missing user-facing messages are easy to spot
      },
    });
  }, [error, correlationId, wasSuppressed]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#F6F6F6] text-center">
      <div className="max-w-md w-full bg-white rounded-2xl border p-6">
        <h2 className="text-lg font-bold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-sm text-[#888] mb-6">{message}</p>
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-[#0F0F14] text-white rounded-xl text-sm font-semibold hover:bg-black transition-colors w-full"
        >
          Try again
        </button>
        <p className="mt-4 text-[11px] text-[#AAA] font-mono break-all">
          Reference: {error.digest ?? correlationId}
        </p>
      </div>
    </div>
  );
}
