"use client";

import { useEffect } from "react";

/**
 * Registers the Serwist-built service worker manually (Serwist `register:false`).
 *
 * We do it from bundled client JS rather than an injected inline <script> so it
 * is allowed under our strict, nonce-based CSP (`strict-dynamic`) without needing
 * `script-src 'unsafe-inline'`.
 */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const register = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* registration is best-effort; app works without it */
      });
    };

    if (document.readyState === "complete") register();
    else {
      window.addEventListener("load", register, { once: true });
      return () => window.removeEventListener("load", register);
    }
  }, []);

  return null;
}
