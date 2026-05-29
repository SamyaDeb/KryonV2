"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWalletStore } from "@/stores/wallet";
import { STELLAR_EXPERT_URL } from "@/config";

interface FillNotification {
  id: string;
  marketId: number;
  isMaker: boolean;
  price: string;
  size: string;
  txHash: string;
  createdAt: number;
}

function useFillNotifications(address: string | null) {
  const [fills, setFills] = useState<FillNotification[]>([]);
  const sinceRef = useRef<number>(Date.now());

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

export function SettlementModal() {
  const { address, connected } = useWalletStore();
  const { fills, dismiss } = useFillNotifications(connected ? address : null);

  if (!fills.length) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-[320px]">
      {fills.slice(0, 3).map((fill) => (
        <FillCard key={fill.id} fill={fill} onDismiss={() => dismiss(fill.id)} />
      ))}
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
          <span className="text-[13px] font-semibold text-[#e6e6e6]">
            Order Filled
          </span>
        </div>
        <button onClick={onDismiss} className="text-[#5a5f66] hover:text-[#8a8f97] text-lg leading-none">
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
          valueClass={isOnChain ? "text-[#1fae5b]" : "text-[#8a8f97]"}
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

function Row({
  label,
  value,
  valueClass = "text-[#dde2ef]",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex justify-between text-[12px]">
      <span className="text-[#5a5f66]">{label}</span>
      <span className={`font-medium tabular ${valueClass}`}>{value}</span>
    </div>
  );
}
