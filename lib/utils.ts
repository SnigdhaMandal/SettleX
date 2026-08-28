import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { xlmToStroops } from "./split/calculator";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatAddress(address: string, chars = 6): string {
  if (!address) return "";
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function formatXLM(amount: string | number | bigint): string {
  try {
    const stroops = xlmToStroops(amount);
    const isNegative = stroops < 0n;
    const absStroops = isNegative ? -stroops : stroops;
    const whole = absStroops / 10_000_000n;
    const frac = absStroops % 10_000_000n;

    const wholeStr = new Intl.NumberFormat("en-US").format(whole);
    const rawFracStr = frac.toString().padStart(7, "0");
    let trimmedFracStr = rawFracStr.replace(/0+$/, "");
    if (trimmedFracStr.length < 2) {
      trimmedFracStr = trimmedFracStr.padEnd(2, "0");
    }

    const formatted = `${wholeStr}.${trimmedFracStr}`;
    return isNegative ? `-${formatted}` : formatted;
  } catch {
    const num = typeof amount === "number" ? amount : parseFloat(String(amount)) || 0;
    return new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 7,
    }).format(num);
  }
}
