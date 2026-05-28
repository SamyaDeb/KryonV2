"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/store/wallet";
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
    freighterGetAddress().then((addr) => {
      if (addr) {
        setAddress(addr);
        setConnected(true);
        isOnTestnet().then((ok) => setWrongNetwork(!ok));
      }
    });
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
        className="px-[18px] py-[10px] rounded-[8px] text-[13.5px] font-semibold text-[#0a0b0d] border border-[#d4d4d4] transition-opacity disabled:opacity-50"
        style={{
          background: "linear-gradient(180deg,#e7e7e7,#bfbfbf)",
          letterSpacing: ".01em",
        }}
        onMouseOver={(e) =>
          (e.currentTarget.style.background = "linear-gradient(180deg,#f5f5f5,#d4d4d4)")
        }
        onMouseOut={(e) =>
          (e.currentTarget.style.background = "linear-gradient(180deg,#e7e7e7,#bfbfbf)")
        }
      >
        {connecting ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {wrongNetwork && (
        <span className="text-[10px] bg-amber-500/15 text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded font-semibold">
          Wrong network
        </span>
      )}
      <button
        onClick={disconnect}
        title="Click to disconnect"
        className="flex items-center gap-2 bg-[#14171c] border border-[#1f232a] rounded-[7px] px-3 py-[7px] hover:border-[#2a2f37] transition-colors"
      >
        <div className="w-1.5 h-1.5 rounded-full bg-[#1fae5b]" style={{ boxShadow: "0 0 6px rgba(31,174,91,0.6)" }} />
        <span className="text-[12.5px] text-[#e6e6e6] font-mono">{shortenAddress(address!)}</span>
      </button>
    </div>
  );
}
