"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import {
  freighterConnect,
  freighterGetAddress,
  freighterIsInstalled,
  isOnTestnet,
} from "@/lib/stellar/freighter";
import { shortenAddress } from "@/lib/format";
import { toast } from "sonner";

export function WalletConnect() {
  const {
    address,
    connected,
    connecting,
    wrongNetwork,
    setAddress,
    setConnected,
    setConnecting,
    setWrongNetwork,
    disconnect,
  } = useWalletStore();

  useEffect(() => {
    let cancelled = false;
    async function refreshWalletState() {
      const addr = await freighterGetAddress();
      if (cancelled) return;
      if (addr) {
        setAddress(addr);
        setConnected(true);
        const ok = await isOnTestnet();
        if (!cancelled) setWrongNetwork(!ok);
      } else {
        setAddress(null);
        setConnected(false);
        setWrongNetwork(false);
      }
    }

    refreshWalletState();
    const id = setInterval(refreshWalletState, 3_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setAddress, setConnected, setWrongNetwork]);

  async function handleConnect() {
    const installed = await freighterIsInstalled();
    if (!installed) {
      toast.error("Freighter not found — install from freighter.app then refresh.");
      return;
    }
    setConnecting(true);
    try {
      const addr = await freighterConnect();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnTestnet();
      setWrongNetwork(!ok);
      if (!ok) toast.warning("Switch Freighter to Stellar Testnet.");
      else toast.success("Wallet connected");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setConnecting(false);
    }
  }

  if (!connected) {
    return (
      <button
        onClick={handleConnect}
        disabled={connecting}
        className="px-[18px] py-[10px] rounded-[8px] text-[13.5px] font-semibold text-[#19191A] transition-opacity disabled:opacity-50"
        style={{
          background: "#f5f5f5",
          letterSpacing: ".01em",
        }}
        onMouseOver={(e) => (e.currentTarget.style.background = "#e5e7eb")}
        onMouseOut={(e) => (e.currentTarget.style.background = "#f5f5f5")}
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  function handleDisconnect() {
    disconnect();
    toast.success("Wallet disconnected");
  }

  return (
    <div className="flex items-center gap-1.5">
      {wrongNetwork && (
        <span className="text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-semibold">
          Wrong network
        </span>
      )}
      <button
        onClick={handleDisconnect}
        title="Click to disconnect"
        className="flex items-center bg-[#212128] border border-[#2A2A31] rounded-[7px] px-[18px] py-[8px] hover:border-red-500/40 hover:bg-red-500/5 transition-colors group"
      >
        <span className="text-[14px] text-[#f5f5f5] font-mono group-hover:text-red-400 transition-colors">{shortenAddress(address!)}</span>
      </button>
    </div>
  );
}
