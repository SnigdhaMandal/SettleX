"use client";

import React from "react";
import { motion } from "framer-motion";
import { Zap, ShieldCheck, Coins, Code2 } from "lucide-react";

// Verifiable capability facts — not invented usage metrics. Each is either a
// property of the Stellar network or independently checkable in this repo.
const stats = [
  {
    icon: Zap,
    value: "~5s",
    unit: "",
    label: "Settlement finality",
    sub: "Stellar consensus speed",
    color: "#B9FF66",
  },
  {
    icon: ShieldCheck,
    value: "100%",
    unit: "",
    label: "Non-custodial",
    sub: "Keys never leave your wallet",
    color: "#B9FF66",
  },
  {
    icon: Coins,
    value: "<$0.01",
    unit: "",
    label: "Network fee",
    sub: "Zero platform fees",
    color: "#B9FF66",
  },
  {
    icon: Code2,
    value: "Open",
    unit: "",
    label: "Source",
    sub: "Public code · 45 passing tests",
    color: "#B9FF66",
  },
];

export default function StatsSection() {
  return (
    <section className="relative bg-[#F6F6F6] overflow-hidden">
      {/* Divider lime strip */}
      <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, #B9FF66, transparent)" }} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8"
        >
          {stats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className="group relative bg-white rounded-3xl border border-[#E5E5E5] p-6 hover:border-[#B9FF66]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.1)] transition-all duration-300 cursor-default"
              >
                {/* Icon */}
                <div className="w-10 h-10 rounded-xl bg-[#B9FF66]/10 flex items-center justify-center mb-4 group-hover:bg-[#B9FF66]/20 transition-all">
                  <Icon size={18} className="text-[#2D6600]" />
                </div>

                {/* Value */}
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-3xl lg:text-4xl font-black text-[#0F0F14] leading-none">
                    {stat.value}
                  </span>
                  {stat.unit && (
                    <span className="text-sm font-bold text-[#B9FF66]">
                      {stat.unit}
                    </span>
                  )}
                </div>

                {/* Label */}
                <p className="text-sm font-semibold text-[#0F0F14] mb-0.5">
                  {stat.label}
                </p>
                <p className="text-xs text-[#AAA]">{stat.sub}</p>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, #E5E5E5, transparent)" }} />
    </section>
  );
}
