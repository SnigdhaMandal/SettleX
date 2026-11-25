"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  SplitSquareVertical,
  QrCode,
  Shield,
  Zap,
  Receipt,
  BarChart3,
  Globe,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const features = [
  {
    icon: SplitSquareVertical,
    title: "Equal & Custom Splits",
    description:
      "Split any expense equally or set custom weights per person. Supports any number of participants with 7-decimal XLM precision.",
    tag: "Core",
    accent: false,
  },
  {
    icon: Zap,
    title: "Instant Stellar Payments",
    description:
      "Pay directly via the Stellar Network with ~5 second finality. No intermediaries, no waiting — money moves at blockchain speed.",
    tag: "P0",
    accent: true,
  },
  {
    icon: QrCode,
    title: "QR Code Payments",
    description:
      "Generate SEP-0007 compliant QR codes for each payment. Any Stellar-compatible wallet can scan and auto-fill the transaction details.",
    tag: "USP",
    accent: false,
  },
  {
    icon: Receipt,
    title: "On-Chain Receipts",
    description:
      "Every transaction includes a memo permanently recorded on the Stellar ledger — an immutable, transparent receipt for every payment.",
    tag: "USP",
    accent: false,
  },
  {
    icon: BarChart3,
    title: "Auto Settlement",
    description:
      "Minimize the number of transactions using our net-balance algorithm. 5+ individual payments can be reduced to a single transfer.",
    tag: "Smart",
    accent: false,
  },
  {
    icon: Globe,
    title: "Trip Mode",
    description:
      "Group multiple expenses under a single trip. Add members, track all costs, and generate one final settlement for the whole journey.",
    tag: "P2",
    accent: false,
  },
  {
    icon: Shield,
    title: "Non-Custodial & Trustless",
    description:
      "Your private keys never leave your wallet. Powered by the Freighter browser extension — SettleX never holds your funds.",
    tag: "Security",
    accent: false,
  },
  {
    icon: Wallet,
    title: "Freighter Integration",
    description:
      "Connect with one click using the Freighter wallet extension. Fast, non-custodial transaction signing on Stellar Testnet.",
    tag: "Wallet",
    accent: false,
  },
];

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.07 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
  },
};

export default function Features() {
  return (
    <section id="features" className="section-padding bg-[#F6F6F6] relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 50% 100%, rgba(185,255,102,0.08), transparent)",
        }}
      />

      <div className="container-max relative">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-16 max-w-2xl mx-auto"
        >
          <Badge variant="lime" className="mb-4">
            <Zap size={11} className="fill-current" />
            Everything you need
          </Badge>
          <h2 className="heading-section text-[#0F0F14] mb-4">
            Built for real group expenses,
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(135deg, #B9FF66, #7DD835)" }}
            >
              settled on-chain.
            </span>
          </h2>
          <p className="text-[#666] text-lg leading-relaxed">
            Every feature designed around the actual pain of splitting bills — with
            the transparency and security of Stellar blockchain.
          </p>
        </motion.div>

        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                variants={cardVariants}
                className={`group relative p-6 rounded-3xl border transition-all duration-300 cursor-default ${
                  feature.accent
                    ? "bg-[#B9FF66] border-[#B9FF66] hover:shadow-[0_8px_40px_-8px_rgba(185,255,102,0.45)]"
                    : "bg-white border-[#E5E5E5] hover:border-[#B9FF66]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.12)]"
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${
                    feature.accent
                      ? "bg-[#0F0F14] text-[#B9FF66]"
                      : "bg-[#F6F6F6] text-[#0F0F14] group-hover:bg-[#B9FF66]/15 group-hover:text-[#2D6600]"
                  } transition-all duration-200`}
                >
                  <Icon size={18} />
                </div>

                <div className="mb-3">
                  <span
                    className={`text-[10px] font-bold uppercase tracking-widest ${
                      feature.accent ? "text-[#2D6600]" : "text-[#AAA]"
                    }`}
                  >
                    {feature.tag}
                  </span>
                </div>

                <h3
                  className={`text-[17px] font-bold mb-2 leading-snug ${
                    feature.accent ? "text-[#0F0F14]" : "text-[#0F0F14]"
                  }`}
                >
                  {feature.title}
                </h3>
                <p
                  className={`text-sm leading-relaxed ${
                    feature.accent ? "text-[#0F0F14]/70" : "text-[#666]"
                  }`}
                >
                  {feature.description}
                </p>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
