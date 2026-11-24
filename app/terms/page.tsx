import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Scale, AlertTriangle, CheckCircle2 } from "lucide-react";
import Header from "@/components/layout/Header";
import Footer from "@/components/layout/Footer";

export const metadata: Metadata = {
  title: "Terms of Service",
  description:
    "Terms of Service for SettleX — decentralized expense-splitting application on the Stellar network.",
};

export default function TermsPage() {
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
              <Scale size={12} className="text-[#2D6600]" />
              Legal & User Agreement
            </div>
            <h1 className="text-3xl sm:text-4xl font-black text-[#0F0F14] tracking-tight mb-2">
              Terms of Service
            </h1>
            <p className="text-sm text-[#888] mb-8">
              Effective Date: November 24, 2026 · Version 1.0
            </p>

            <div className="prose prose-neutral max-w-none space-y-6 text-[#555] text-sm sm:text-base leading-relaxed">
              <p>
                Welcome to <strong>SettleX</strong>. By accessing or using the SettleX web application, you acknowledge
                that you have read, understood, and agree to be bound by these Terms of Service. If you do not agree to these
                terms, please discontinue use of the application.
              </p>

              {/* Testnet banner alert */}
              <div className="p-4 rounded-2xl bg-amber-50 border border-amber-200 flex items-start gap-3 my-6">
                <AlertTriangle size={18} className="text-amber-600 mt-0.5 shrink-0" />
                <div className="text-sm text-amber-900 leading-normal">
                  <strong className="font-semibold">Testnet Notice:</strong> SettleX is currently operating on the{" "}
                  <strong>Stellar Testnet</strong> for evaluation and testing purposes. Testnet XLM has no real-world monetary
                  value. Do not attempt to use real funds, and do not treat testnet activity as actual financial transactions.
                </div>
              </div>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                1. Nature of the Service
              </h2>
              <p>
                SettleX provides a software interface for calculating shared expenses, generating cryptographic payment
                parameters (including SEP-0007 QR codes), and coordinating peer-to-peer settlement across the Stellar blockchain.
              </p>
              <p>
                <strong>SettleX is non-custodial:</strong> We are not a bank, broker-dealer, money services business, or custodian.
                We do not hold, manage, or intermediate any funds. All transactions are created locally and authorized directly by
                your independent wallet software.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                2. User Responsibilities & Wallet Security
              </h2>
              <ul className="list-disc pl-5 space-y-2">
                <li>
                  <strong>Private Key Custody:</strong> You are solely responsible for the security and backup of your private keys
                  and recovery seeds. If you lose access to your wallet, SettleX cannot recover your assets or reverse transactions.
                </li>
                <li>
                  <strong>Verification of Transactions:</strong> Blockchain payments on the Stellar network are irreversible. You
                  must verify all recipient public addresses, amounts, and payment memos before confirming any transaction in your wallet.
                </li>
                <li>
                  <strong>Lawful Use:</strong> You agree not to use SettleX for any unlawful activity, money laundering, fraud, or
                  activities that violate international sanctions or applicable local regulations.
                </li>
              </ul>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                3. No Financial, Tax, or Legal Advice
              </h2>
              <p>
                The mathematical split algorithms and payment records provided by SettleX are informational software utilities.
                Nothing contained within the application constitutes financial, investment, accounting, or legal advice.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                4. Disclaimer of Warranties
              </h2>
              <p>
                THE APPLICATION IS PROVIDED ON AN &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; BASIS WITHOUT ANY WARRANTIES OF ANY KIND,
                WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE. WE EXPRESSLY DISCLAIM ALL WARRANTIES OF MERCHANTABILITY,
                FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT.
              </p>
              <p>
                We do not warrant that the application will function uninterrupted, be secure, or remain free from errors, bugs, or
                delays caused by blockchain network congestion or external node failures.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                5. Limitation of Liability
              </h2>
              <p>
                TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL SETTLEX, ITS MAINTAINERS, CONTRIBUTORS, OR
                AFFILIATES BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING BUT NOT
                LIMITED TO LOSS OF FUNDS, DIGITAL ASSETS, PROFITS, DATA, OR GOODWILL ARISING FROM OR RELATED TO YOUR USE OF THE APPLICATION.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                6. Open Source License & Modifications
              </h2>
              <p>
                SettleX is released under an open-source license. We reserve the right to modify, improve, or discontinue any feature
                of the application at any time without prior notice. These terms may be revised periodically, and continued use of the
                application represents acceptance of any modifications.
              </p>

              <h2 className="text-xl font-bold text-[#0F0F14] pt-4 border-t border-[#F0F0F0]">
                7. Contact
              </h2>
              <p>
                If you have questions or inquiries regarding these Terms of Service, please reach out via our GitHub repository at{" "}
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
