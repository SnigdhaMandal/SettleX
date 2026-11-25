"use client";

// Fallback when the root layout itself crashes — renders its own html/body with
// inline styles since providers and Tailwind may not have loaded, and omits error.message.
import { useEffect, useState } from "react";
import { newCorrelationId, reportError } from "@/lib/observability/logger";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [correlationId] = useState(newCorrelationId);

  useEffect(() => {
    reportError("ui.global_error", error, {
      correlationId,
      fields: { digest: error.digest, boundary: "app/global-error" },
    });
  }, [error, correlationId]);

  return (
    <html lang="en">
      <body
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "1rem",
          margin: 0,
          background: "#F6F6F6",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
          textAlign: "center",
        }}
      >
        <div
          style={{
            maxWidth: "28rem",
            width: "100%",
            background: "#fff",
            borderRadius: "1rem",
            border: "1px solid #E5E5E5",
            padding: "1.5rem",
          }}
        >
          <h2
            style={{
              fontSize: "1.125rem",
              fontWeight: 700,
              color: "#DC2626",
              margin: "0 0 0.5rem",
            }}
          >
            Something went wrong
          </h2>
          <p style={{ fontSize: "0.875rem", color: "#888", margin: "0 0 1.5rem" }}>
            The app failed to load. Your data is safe — nothing was changed.
          </p>
          <button
            onClick={() => reset()}
            style={{
              width: "100%",
              padding: "0.5rem 1rem",
              background: "#0F0F14",
              color: "#fff",
              borderRadius: "0.75rem",
              border: "none",
              fontSize: "0.875rem",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          <p
            style={{
              marginTop: "1rem",
              fontSize: "11px",
              color: "#AAA",
              fontFamily: "ui-monospace, monospace",
              wordBreak: "break-all",
            }}
          >
            Reference: {error.digest ?? correlationId}
          </p>
        </div>
      </body>
    </html>
  );
}
