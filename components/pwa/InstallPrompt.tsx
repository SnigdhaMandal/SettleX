"use client";

import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "settlex:install-dismissed";

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Cross-platform "install this app" nudge.
 *  - Android / desktop Chrome: uses the native `beforeinstallprompt` event.
 *  - iOS Safari: has no such event, so we show a one-time "Add to Home Screen" hint.
 * Dismissal is remembered so we never nag.
 */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [show, setShow] = useState(false);
  const [iosHint, setIosHint] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;
    if (typeof localStorage !== "undefined" && localStorage.getItem(DISMISS_KEY)) return;

    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setShow(true);
    };
    window.addEventListener("beforeinstallprompt", onBeforeInstall);

    // iOS never fires the event — offer the manual path instead.
    if (isIos()) {
      setIosHint(true);
      setShow(true);
    }

    const onInstalled = () => setShow(false);
    window.addEventListener("appinstalled", onInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = () => {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* private mode — fine */
    }
  };

  const install = async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setShow(false);
  };

  if (!show) return null;

  return (
    <div
      role="dialog"
      aria-label="Install SettleX"
      className="fixed inset-x-0 bottom-0 z-[9998] flex justify-center px-4"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 16px)" }}
    >
      <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-[#E5E5E5] bg-white p-3 shadow-card">
        <img src="/brand/logo-mark.svg" alt="" width={40} height={40} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-[#0F0F14]">Install SettleX</p>
          <p className="truncate text-xs text-[#888888]">
            {iosHint ? "Tap Share → Add to Home Screen" : "Add to your home screen for a faster, app-like experience."}
          </p>
        </div>
        {!iosHint && (
          <button
            type="button"
            onClick={install}
            className="shrink-0 rounded-xl bg-[#B9FF66] px-4 py-2 text-sm font-semibold text-[#0F0F14] transition hover:bg-[#9AE040]"
          >
            Install
          </button>
        )}
        <button
          type="button"
          onClick={dismiss}
          aria-label="Dismiss"
          className="shrink-0 rounded-lg p-2 text-[#999] transition hover:bg-black/5"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
