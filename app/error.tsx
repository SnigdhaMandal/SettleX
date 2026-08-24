"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-[#F6F6F6] text-center">
      <div className="max-w-md w-full bg-white rounded-2xl border p-6">
        <h2 className="text-lg font-bold text-red-600 mb-2">Something went wrong</h2>
        <p className="text-sm text-[#888] mb-6">
          {error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={() => reset()}
          className="px-4 py-2 bg-[#0F0F14] text-white rounded-xl text-sm font-semibold hover:bg-black transition-colors w-full"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
