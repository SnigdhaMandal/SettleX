import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "SettleX — Split & Settle On-Chain",
    short_name: "SettleX",
    description:
      "Split expenses and settle in seconds with USDC or XLM. Non-custodial, verifiable receipts.",
    id: "/",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0F0F14",
    theme_color: "#B9FF66",
    categories: ["finance", "productivity", "utilities"],
    icons: [
      { src: "/pwa-icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa-icon?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa-icon?size=192&mask=1", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/pwa-icon?size=512&mask=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Dashboard", url: "/dashboard" },
      { name: "Trips", url: "/trips" },
      { name: "Expenses", url: "/expenses" },
    ],
  };
}
