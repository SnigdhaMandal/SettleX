import React from "react";

/**
 * Shared social-card layout rendered by `next/og` (Satori) for both the
 * OpenGraph and Twitter images. Satori supports a subset of CSS: every element
 * with more than one child must declare `display: "flex"`. Fonts fall back to a
 * system sans; the mark is drawn as inline SVG (Satori-supported).
 */
export function OgCard() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        backgroundColor: "#0F0F14",
        backgroundImage:
          "radial-gradient(ellipse 90% 70% at 50% -10%, rgba(185,255,102,0.18), transparent)",
        padding: "72px",
        fontFamily: "sans-serif",
      }}
    >
      {/* Brand row */}
      <div style={{ display: "flex", alignItems: "center", gap: "20px" }}>
        <svg width="72" height="72" viewBox="0 0 48 48">
          <rect x="4" y="4" width="40" height="40" rx="12" fill="#B9FF66" />
          <path
            d="M 24 9.5 L 14.5 25.5 H 21 L 16.5 38.5 L 27 22.5 H 20.5 L 24 9.5 Z"
            fill="#0F0F14"
          />
        </svg>
        <div style={{ display: "flex", fontSize: "40px", fontWeight: 800, color: "#FFFFFF" }}>
          SettleX
        </div>
      </div>

      {/* Headline */}
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div
          style={{
            display: "flex",
            fontSize: "76px",
            fontWeight: 800,
            color: "#FFFFFF",
            lineHeight: 1.05,
            letterSpacing: "-2px",
          }}
        >
          Split bills. Settle on-chain
        </div>
        <div
          style={{
            display: "flex",
            fontSize: "76px",
            fontWeight: 800,
            color: "#B9FF66",
            lineHeight: 1.05,
            letterSpacing: "-2px",
          }}
        >
          in seconds.
        </div>
      </div>

      {/* Footer strap */}
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <div style={{ display: "flex", width: "48px", height: "6px", backgroundColor: "#B9FF66", borderRadius: "3px" }} />
        <div style={{ display: "flex", fontSize: "30px", color: "#B8B8C0" }}>
          USDC or XLM · non-custodial · verifiable receipts
        </div>
      </div>
    </div>
  );
}
