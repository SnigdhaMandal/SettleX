import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline",
  robots: { index: false, follow: false },
};

// Precached by the service worker and shown when a navigation request fails
// while offline. Intentionally dependency-free so it always renders.
export default function OfflinePage() {
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "20px",
        padding: "24px",
        textAlign: "center",
        backgroundColor: "#0F0F14",
        color: "#FFFFFF",
      }}
    >
      <svg width="64" height="64" viewBox="0 0 48 48" aria-hidden>
        <rect x="4" y="4" width="40" height="40" rx="10" fill="#B9FF66" />
        <path
          d="M 24 9.5 L 14.5 25.5 H 21 L 16.5 38.5 L 27 22.5 H 20.5 L 24 9.5 Z"
          fill="#0F0F14"
        />
      </svg>
      <h1 style={{ fontSize: "24px", fontWeight: 800, margin: 0 }}>You&rsquo;re offline</h1>
      <p style={{ color: "#B8B8C0", maxWidth: "360px", margin: 0, lineHeight: 1.5 }}>
        SettleX needs a connection to read balances and settle payments. Your
        last-synced trips are still on your device — reconnect to continue.
      </p>
      <a
        href="/dashboard"
        style={{
          marginTop: "8px",
          padding: "12px 24px",
          borderRadius: "16px",
          backgroundColor: "#B9FF66",
          color: "#0F0F14",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        Try again
      </a>
    </main>
  );
}
