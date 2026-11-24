import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Shield, Lock, FileText, CheckCircle2 } from "lucide-react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description:
    "Privacy policy for SettleX — non-custodial decentralized expense splitting on the Stellar network.",
};

export default function PrivacyPage() {
  return (
    <>
      <Header />
      <main className="min-h-screen bg-[#F6F6F6] pt-32 pb-24">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* Breadcrumb back */}
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-sm font-semibold text-[#666] hover:text-[#0F0F14] mb-8 transition-colors"
          >
            <ArrowLeft size={16} />
            Back to Home
          </Link>

          <article className="bg-white rounded-3xl border border-[#E5E5E5] p-8 sm:p-12 shadow-[0_4px_32px_-8px_rgba(0,0,0,0.06)]">
            {/* Header badge and title */}
            <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#B9FF66]/20 border border-[#B9FF66]/30 rounded-full text-xs font-semibold text-[#2D6600] mb-4">
              <Shield size={12} className="text-[#2D6600]" />
              Trust & Transparency
            </div>
            <h1 className="text-3xl sm:text-4xl font-black text-[#0F0F14] tracking-tight mb-2">
              Privacy Policy
            </h1>
            <p className="text-sm text-[#888] mb-8">
              Effective Date: November 24, 2026 · Version 1.0
            </p>

            <div className="prose prose-neutral max-w-none space-y-6 text-[#555] text-sm sm:text-base leading-relaxed">
              <p>
                At <strong>SettleX</strong>, we believe privacy is foundational to trust. SettleX is designed as a
                non-custodial, peer-to-peer expense coordination and settlement application built on the Stellar blockchain.
                This Privacy Policy explains how information is handled when you use the SettleX web application.
              </p>

              <div className="p-4 rounded-2xl bg-[#B9FF66]/10 border border-[#B9FF66]/30 flex items-start gap-3 my-6">
                <CheckCircle2 size={18} className="text-[#2D6600] mt-0.5 shrink-0" />
                <p className="text-sm text-[#2D6600] font-medium leading-normal">
                  <strong>Core Commitment:</strong> SettleX is non-custodial. We never collect, transmit, or store your
                  private keys, seed phrases, or wallet passwords. All transaction signing occurs exclusively inside your
                  own wallet application.
                </p>
              </div>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                1. Information We Access and Collect
              </h2>
              <p>We collect and process only the minimum data required to facilitate expense tracking and settlement:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong>Public Wallet Address:</strong> When you connect your Stellar wallet (such as Freighter), we
                  read your public key (e.g., <code className="text-xs bg-[#F6F6F6] px-1.5 py-0.5 rounded font-mono text-[#0F0F14]">G...</code>)
                  to identify your account, resolve balances, and enable other group members to send payments to you.
                </li>
                <li>
                  <strong>Group & Expense Records:</strong> Group titles, trip names, member nicknames, expense amounts,
                  split allocations, and payment status flags are stored in our secure database to coordinate calculations
                  among your group members.
                </li>
                <li>
                  <strong>Cryptographic Session Tokens:</strong> For authentication, we use standard wallet-signed challenges
                  (SEP-0010) to issue temporary session cookies. We do not require or collect emails, passwords, or personal identity documents.
                </li>
                <li>
                  <strong>Offline Application Cache:</strong> SettleX utilizes local browser storage and Service Worker caching
                  so you can view your trip expenses offline. This data resides solely on your device.
                </li>
              </ul>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                2. On-Chain Blockchain Data
              </h2>
              <p>
                When you execute a payment on the Stellar network, transaction metadata is permanently recorded on the
                public, decentralized Stellar ledger. This includes:
              </p>
              <ul className="list-disc pl-5 space-y-2">
                <li>Sender and recipient public Stellar addresses.</li>
                <li>Transfer amount (in XLM) and transaction fees paid to validators.</li>
                <li>Payment memo and ledger sequence number.</li>
                <li>The cryptographic transaction hash.</li>
              </ul>
              <p>
                Public blockchain data is immutable, transparent, and globally verifiable. SettleX has no ability to alter,
                erase, or restrict public ledger records.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                3. Third-Party Services
              </h2>
              <p>SettleX interacts with the following external protocols and infrastructure providers:</p>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong>Stellar Horizon & RPC Nodes:</strong> Used to submit signed transactions and query account balances.
                </li>
                <li>
                  <strong>Supabase (PostgreSQL):</strong> Used to store off-chain group and expense metadata under strict row-level security (RLS).
                </li>
                <li>
                  <strong>Freighter Wallet (Stellar Development Foundation):</strong> Manages cryptographic keys and signs transactions.
                  Please consult Freighter’s privacy documentation for their independent practices.
                </li>
              </ul>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                4. Data Protection and User Rights
              </h2>
              <p>
                We do not sell, rent, monetize, or broker your personal information. Any off-chain expense or trip records you create
                may be deleted or edited directly through the application by the trip or expense creator.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                5. Changes to This Policy
              </h2>
              <p>
                We may revise this Privacy Policy from time to time. When changes occur, the updated policy will be published here
                with an updated effective date.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                6. Contact & Open Source Inquiries
              </h2>
              <p>
                SettleX is open-source software. If you have questions about privacy practices or wish to submit feedback, please
                open an issue in our official repository at{" "}
                <a
                  href="https://github.com/SnigdhaMandal/SettleX/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[#2D6600] font-semibold underline"
                >
                  GitHub Issues
                </a>
                .
              </p>
            </div>
          </article>
        </div>
      </main>
      <Footer />
    </>
  );
}
