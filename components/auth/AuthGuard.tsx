"use client";

import React, { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/ui/Spinner";
import { Button } from "@/components/ui/Button";
import { ShieldAlert } from "lucide-react";

interface AuthGuardProps {
  children: React.ReactNode;
}

/**
 * Protects routes by requiring authentication.
 * Redirects to /auth if user is not authenticated.
 *
 * `isAuthenticated` is derived from the verified session token, not from cached
 * localStorage state, so forging `settlex:user` / `settlex:publicKey` does not
 * get past this guard. It is defence in depth either way: RLS rejects every
 * request that lacks a server-signed `wallet_address` claim, so bypassing the
 * guard in the client would still yield an app with no data.
 */
export function AuthGuard({ children }: AuthGuardProps) {
  const { isAuthenticated, isLoading, user, sessionError, refreshSession } = useAuth();
  const [isRetrying, setIsRetrying] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !sessionError && !isAuthenticated) {
      router.push("/auth");
    }
  }, [isAuthenticated, isLoading, sessionError, router]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F6F6]">
        <div className="text-center">
          <Spinner size={48} />
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  // The wallet never proved key ownership, so every database call would be
  // rejected. Ask for a signature rather than showing a half-working app.
  if (sessionError) {
    const retry = async () => {
      setIsRetrying(true);
      try {
        await refreshSession();
      } finally {
        setIsRetrying(false);
      }
    };

    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F6F6F6] px-4">
        <div className="max-w-md w-full bg-white rounded-3xl shadow-[0_8px_60px_-12px_rgba(0,0,0,0.18)] p-8 text-center">
          <div className="w-12 h-12 rounded-2xl bg-[#FF6B6B]/10 flex items-center justify-center mx-auto mb-5">
            <ShieldAlert size={24} className="text-[#FF6B6B]" />
          </div>
          <h1 className="text-xl font-black text-[#0F0F14] mb-2">
            Verify your wallet
          </h1>
          <p className="text-sm text-[#666] leading-relaxed mb-6">
            SettleX needs a signature from your wallet to prove you own this
            address. Nothing is submitted to the network and no fee is charged.
          </p>
          <p className="text-xs text-[#888] bg-[#F6F6F6] rounded-xl px-4 py-3 mb-6 break-words">
            {sessionError}
          </p>
          <Button
            onClick={retry}
            disabled={isRetrying}
            className="w-full bg-[#0F0F14] text-white hover:bg-[#2a2a2f] h-12 font-bold rounded-xl"
          >
            {isRetrying ? "Waiting for your wallet…" : "Sign to continue"}
          </Button>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return null; // Will redirect in useEffect
  }

  return <>{children}</>;
}
