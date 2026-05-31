"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWalletStore } from "@/stores/wallet";
import { STELLAR_EXPERT_URL } from "@/config";
import { freighterSignAuthEntry } from "@/lib/stellar/freighter";

interface FillNotification {
  id: string;
  marketId: number;
  isMaker: boolean;
  price: string;
  size: string;
  txHash: string;
  createdAt: number;
}

interface PendingSettlement {
  id: string;
  marketId: number;
  isMaker: boolean;
  fillHash: string;
  authEntryXdr: string;
  fillPrice: string;
  fillSize: string;
  createdAt: string;
}

function useFillNotifications(address: string | null) {
  const [fills, setFills] = useState<FillNotification[]>([]);
  const sinceRef = useRef<number>(0);

  const poll = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(
        `/api/fills?address=${address}&since=${sinceRef.current}&limit=10`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as FillNotification[];
      if (data.length > 0) {
        sinceRef.current = Math.max(...data.map((f) => f.createdAt)) + 1;
        setFills((prev) => [...data, ...prev].slice(0, 20));
      }
    } catch { /* best-effort */ }
  }, [address]);

  useEffect(() => {
    if (!address) return;
    // Reset timestamp when address changes
    sinceRef.current = Date.now() - 5_000; // look back 5s on connect
    poll();
    const id = setInterval(poll, 3_000);
    return () => clearInterval(id);
  }, [address, poll]);

  return { fills, dismiss: (id: string) => setFills((p) => p.filter((f) => f.id !== id)) };
}

function usePendingSettlements(address: string | null) {
  const [pending, setPending] = useState<PendingSettlement[]>([]);

  const poll = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch(`/api/settlements?address=${address}`, { cache: "no-store" });
      if (!res.ok) return;
      setPending((await res.json()) as PendingSettlement[]);
    } catch { /* best-effort */ }
  }, [address]);

  useEffect(() => {
    if (!address) {
      queueMicrotask(() => setPending([]));
      return;
    }
    const first = setTimeout(poll, 0);
    const id = setInterval(poll, 4_000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [address, poll]);

  return { pending, refresh: poll };
}

export function SettlementModal() {
  const { address, connected } = useWalletStore();
  const { fills, dismiss } = useFillNotifications(connected ? address : null);
  const { pending, refresh } = usePendingSettlements(connected ? address : null);

  if (!fills.length && !pending.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-[320px]">
      {pending.slice(0, 2).map((settlement) => (
        <PendingSettlementCard
          key={settlement.id}
          settlement={settlement}
          address={address}
          onSigned={refresh}
        />
      ))}
      {fills.slice(0, 3).map((fill) => (
        <FillCard key={fill.id} fill={fill} onDismiss={() => dismiss(fill.id)} />
      ))}
    </div>
  );
}

function PendingSettlementCard({
  settlement,
  address,
  onSigned,
}: {
  settlement: PendingSettlement;
  address: string | null;
  onSigned: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const role = settlement.isMaker ? "Maker" : "Taker";

  const signSettlement = async () => {
    if (!address || busy) return;
    setBusy(true);
    setError(null);
    try {
      const signedAuthEntry = await freighterSignAuthEntry(settlement.authEntryXdr);
      const res = await fetch(`/api/settlements/${settlement.id}/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address, signedAuthEntry }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error ?? "Settlement signing failed");
      }
      onSigned();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Settlement signing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="rounded-[14px] border border-[#3a2a12] shadow-2xl overflow-hidden"
      style={{ background: "#140f07" }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#3a2a12]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-amber-400" style={{ boxShadow: "0 0 6px rgba(251,191,36,.7)" }} />
          <span className="text-[13px] font-semibold text-[#f4ead7]">
            Settlement Signature
          </span>
        </div>
        <span className="text-[11px] text-[#a98d54]">{role}</span>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2">
        <Row label="Size" value={`${formatRawAmount(settlement.fillSize)} XLM`} />
        <Row label="Price" value={`$${formatRawPrice(settlement.fillPrice)}`} />
        <Row label="Status" value="Wallet auth required" valueClass="text-amber-300" />
        {error && <div className="text-[11px] leading-4 text-red-300">{error}</div>}
      </div>

      <div className="px-4 pb-4">
        <button
          type="button"
          onClick={signSettlement}
          disabled={busy}
          className="block w-full py-[9px] rounded-[8px] text-center text-[13px] font-semibold text-[#140f07] bg-amber-300 hover:bg-amber-200 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? "Signing..." : "Sign Settlement"}
        </button>
      </div>
    </div>
  );
}

function FillCard({
  fill,
  onDismiss,
}: {
  fill: FillNotification;
  onDismiss: () => void;
}) {
  const isOnChain = !fill.txHash.startsWith("dbfill");
  const role = fill.isMaker ? "Maker" : "Taker";

  // Auto-dismiss after 12 s
  useEffect(() => {
    const t = setTimeout(onDismiss, 12_000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      className="rounded-[14px] border border-[#1a2a1a] shadow-2xl overflow-hidden"
      style={{ background: "#0a140a" }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a2a1a]">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-[#1fae5b]" style={{ boxShadow: "0 0 6px rgba(31,174,91,.7)" }} />
          <span className="text-[13px] font-semibold text-[#f5f5f5]">
            Order Filled
          </span>
        </div>
        <button onClick={onDismiss} className="text-[#737373] hover:text-[#a3a3a3] text-lg leading-none">
          ×
        </button>
      </div>

      <div className="px-4 py-3 flex flex-col gap-2">
        <Row label="Size"  value={`${fill.size} XLM`} />
        <Row label="Price" value={`$${fill.price}`} />
        <Row
          label="Role"
          value={role}
          valueClass={fill.isMaker ? "text-[#9aa0ff]" : "text-amber-400"}
        />
        <Row
          label="Settlement"
          value={isOnChain ? "On-chain ✓" : "Off-chain (pending)"}
          valueClass={isOnChain ? "text-[#1fae5b]" : "text-[#a3a3a3]"}
        />
      </div>

      {isOnChain && (
        <div className="px-4 pb-4">
          <a
            href={`${STELLAR_EXPERT_URL}/tx/${fill.txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full py-[9px] rounded-[8px] text-center text-[13px] font-semibold text-[#1fae5b] border border-[#1a3a1a] hover:bg-[#0d1f0d] transition-colors"
          >
            View on Explorer →
          </a>
        </div>
      )}
    </div>
  );
}

function formatRawPrice(value: string) {
  return (Number(value) / 1e18).toFixed(4);
}

function formatRawAmount(value: string) {
  return (Number(value) / 1e7).toFixed(4);
}

function Row({
  label,
  value,
  valueClass = "text-[#f5f5f5]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between text-[12px]">
      <span className="text-[#737373]">{label}</span>
      <span className={`font-medium tabular ${valueClass}`}>{value}</span>
    </div>
  );
}
