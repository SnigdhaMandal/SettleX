import type { Metadata, Viewport } from "next";
import "./globals.css";
import { WalletProvider } from "@/context/WalletContext";
import { AuthProvider } from "@/context/AuthContext";
import { ToastProvider } from "@/components/ui/Toast";
import { ExpenseProvider } from "@/context/ExpenseContext";
import { TripProvider } from "@/context/TripContext";

export const metadata: Metadata = {
  metadataBase: new URL("https://settlex.app"),
  title: {
    default: "SettleX — Split Bills on the Stellar Blockchain",
    template: "%s | SettleX",
  },
  description:
    "SettleX is a decentralized bill-splitting app built on the Stellar blockchain. Split expenses, pay instantly with XLM, track with QR codes — all trustless, all transparent.",
  keywords: [
    "Stellar",
    "blockchain",
    "bill splitting",
    "crypto payments",
    "XLM",
    "Freighter wallet",
    "decentralized",
    "group expenses",
    "web3",
  ],
  authors: [{ name: "SettleX Team" }],
  creator: "SettleX",
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://settlex.app",
    siteName: "SettleX",
    title: "SettleX — Split Bills on the Stellar Blockchain",
    description:
      "Decentralized bill-splitting powered by Stellar. Split instantly, pay transparently.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "SettleX — Split Bills on Stellar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "SettleX — Split Bills on the Stellar Blockchain",
    description: "Decentralized bill-splitting powered by Stellar.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: "/icon.svg",
    shortcut: "/icon.svg",
  },
};

export const viewport: Viewport = {
  themeColor: "#B9FF66",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="scroll-smooth">
      <head>
        <link rel="icon" type="image/svg+xml" href="/icon.svg" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,400&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-[#F6F6F6] text-[#0F0F14] font-sans antialiased">
        <ToastProvider>
          <WalletProvider>
            <AuthProvider>
              <ExpenseProvider>
                <TripProvider>
                  {children}
                </TripProvider>
              </ExpenseProvider>
            </AuthProvider>
          </WalletProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
