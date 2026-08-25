"use client";

import React from "react";
import { motion } from "framer-motion";
import { ShieldCheck, Link2, Zap, Clock, Code2, Map } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const CONTRACT_ID = "CAXVH54JVEUCLDQQW45SMRFTCAAVUGVBT4SBVLAGYDQ2YMAPK6YL6ADI";
const SAMPLE_TX = "04c679c7ab7ec960db505038b4c6ec1f367e5d3caae013696bf3111e493de967";
const EXPLORER = "https://stellar.expert/explorer/testnet";
const REPO = "https://github.com/SnigdhaMandal/SettleX";

// Honest, verifiable proof points — no fabricated reviews. Every claim below is
// something a visitor can independently check on-chain or in the source.
const proofs = [
  {
    icon: ShieldCheck,
    title: "Non-custodial by design",
    text: "Your private key never leaves your wallet. SettleX only ever receives a signed transaction — it can’t touch or hold your funds.",
    href: undefined as string | undefined,
    cta: undefined as string | undefined,
  },
  {
    icon: Link2,
    title: "Verifiable on-chain",
    text: "Every settlement produces a real Stellar transaction hash you can open on a public explorer. No trust required — check it yourself.",
    href: `${EXPLORER}/tx/${SAMPLE_TX}`,
    cta: "View a sample transaction",
  },
  {
    icon: Zap,
    title: "Near-zero fees",
    text: "Stellar’s base network fee is a fraction of a US cent, so settling a share costs effectively nothing — even across borders.",
    href: undefined,
    cta: undefined,
  },
  {
    icon: Clock,
    title: "Settles in ~5 seconds",
    text: "Payments confirm on the Stellar network in about five seconds — not the days a bank transfer or remittance can take.",
    href: undefined,
    cta: undefined,
  },
  {
    icon: Code2,
    title: "Open source",
    text: "The full app and the Soroban settlement contract are public. Read the code, run the tests, verify the contract — nothing is hidden.",
    href: REPO,
    cta: "Read the source",
  },
  {
    icon: Map,
    title: "Testnet live, mainnet on the roadmap",
    text: "SettleX runs on Stellar Testnet today, with USDC settlement and a mainnet launch on a published roadmap. We say exactly where we are.",
    href: `${EXPLORER}/contract/${CONTRACT_ID}`,
    cta: "View the live contract",
  },
];

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

export default function Testimonials() {
  return (
    <section className="section-padding bg-[#F6F6F6] relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(185,255,102,0.06), transparent 70%)",
        }}
      />

      <div className="container-max relative">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16 max-w-xl mx-auto"
        >
          <Badge variant="lime" className="mb-4">
            <ShieldCheck size={11} />
            Built to be verified
          </Badge>
          <h2 className="heading-section text-[#0F0F14] mb-4">
            Don’t trust us.{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(135deg, #B9FF66, #7DD835)" }}
            >
              Verify it.
            </span>
          </h2>
          <p className="text-[#666] text-lg">
            SettleX is early and honest about it. Instead of reviews, here’s proof
            you can check yourself — on-chain and in the source.
          </p>
        </motion.div>

        {/* Proof grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {proofs.map((p, i) => {
            const Icon = p.icon;
            return (
              <motion.div
                key={p.title}
                custom={i}
                variants={cardVariants}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true, margin: "-40px" }}
              >
                <div className="h-full bg-white rounded-3xl border border-[#E5E5E5] p-6 hover:border-[#B9FF66]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.1)] transition-all duration-300 flex flex-col">
                  <div className="w-10 h-10 rounded-xl bg-[#B9FF66]/15 flex items-center justify-center mb-4">
                    <Icon size={18} className="text-[#2D6600]" />
                  </div>
                  <h3 className="text-base font-bold text-[#0F0F14] mb-2">{p.title}</h3>
                  <p className="text-[15px] text-[#555] leading-relaxed flex-1">{p.text}</p>
                  {p.href && (
                    <a
                      href={p.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-4 inline-flex items-center gap-1 text-sm font-semibold text-[#2D6600] hover:underline"
                    >
                      {p.cta} →
                    </a>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        {/* Honest metrics — all independently true, no invented user counts */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6 sm:gap-12 mt-12 pt-12 border-t border-[#E5E5E5]"
        >
          {[
            { value: "~5s", label: "Settlement time" },
            { value: "<$0.01", label: "Network fee" },
            { value: "0", label: "Platform fees" },
            { value: "100%", label: "Non-custodial" },
          ].map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-2xl font-black text-[#0F0F14]">{value}</div>
              <div className="text-sm text-[#AAA]">{label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
