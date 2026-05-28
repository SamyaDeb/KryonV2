"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/store/wallet";
import { useLocalOrders } from "@/store/orders";
import { getPositions } from "@/lib/stellar/contracts";
import { PositionsTable } from "./PositionsTable";
import { OpenOrdersTable } from "./OpenOrdersTable";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);
const LinesIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6h12M4 12h16M4 18h8" />
  </svg>
);
function KryonMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" width={34} height={34}>
      <path d="M16 2 L29 9 L29 23 L16 30 L3 23 L3 9 Z" stroke="#d4d4d4" strokeWidth="1.8" />
      <path d="M16 9 L23 13 L23 19 L16 23 L9 19 L9 13 Z" fill="#d4d4d4" />
      <path
        d="M16 2 L16 30 M3 9 L29 23 M29 9 L3 23"
        stroke="#d4d4d4"
        strokeWidth="0.6"
        opacity={0.35}
      />
    </svg>
  );
}

type TabKey = "Positions" | "Open Orders" | "Trade History" | "Order History" | "Funding History";

const STATIC_TABS: TabKey[] = ["Trade History", "Order History", "Funding History"];

export function BottomPanel({ marketId }: { marketId: number }) {
  const [activeTab, setActiveTab] = useState<TabKey>("Positions");
  const { address, connected } = useWalletStore();
  const allOrders = useLocalOrders((s) => s.orders);
  const pendingOrders = allOrders.filter(
    (o) => o.marketId === marketId && o.status === "pending"
  );

  // Fetch positions for count (same query key as PositionsTable — cache hit, no double-fetch)
  const { data: allPositions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const positionCount = allPositions.filter((p) => p.marketId === marketId).length;
  const orderCount = pendingOrders.length;

  const TABS: { key: TabKey; count: number | null }[] = [
    { key: "Positions", count: positionCount },
    { key: "Open Orders", count: orderCount },
    { key: "Trade History", count: null },
    { key: "Order History", count: null },
    { key: "Funding History", count: null },
  ];

  const tabCls = (active: boolean) =>
    `px-4 py-[14px] text-[13px] font-medium relative transition-colors ${
      active
        ? "text-[#e6e6e6] after:content-[''] after:absolute after:left-[14px] after:right-[14px] after:bottom-[-1px] after:h-[2px] after:bg-[#f4f4f4] after:rounded-[2px]"
        : "text-[#8a8f97] hover:text-[#e6e6e6]"
    }`;

  return (
    <div className="rounded-xl border border-[#1f232a] bg-[#0f1217] overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center justify-between border-b border-[#1f232a]">
        <div className="flex">
          {TABS.map(({ key, count }) => (
            <button key={key} className={tabCls(activeTab === key)} onClick={() => setActiveTab(key)}>
              {key}
              {count !== null && (
                <span className={`font-normal ml-1 ${count > 0 ? "text-[#e6e6e6]" : "text-[#5a5f66]"}`}>
                  ({count})
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-[10px] pr-4 py-2">
          <button className="flex items-center gap-2 px-3 py-[7px] rounded-[7px] bg-[#14171c] border border-[#1f232a] text-[12.5px] text-[#8a8f97] hover:border-[#2a2f37] hover:text-[#e6e6e6] transition-colors">
            Market{" "}
            <span className="text-[#e6e6e6] font-medium">All</span>
            <CaretIcon />
          </button>
          <button className="flex items-center gap-2 px-3 py-[7px] rounded-[7px] bg-[#14171c] border border-[#1f232a] text-[12.5px] text-[#8a8f97] hover:border-[#2a2f37] hover:text-[#e6e6e6] transition-colors">
            <LinesIcon />
            <span className="text-[#e6e6e6] font-medium">Both</span>
            <CaretIcon />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="overflow-y-auto" style={{ maxHeight: 180 }}>
        {activeTab === "Positions" && <PositionsTable marketId={marketId} />}
        {activeTab === "Open Orders" && <OpenOrdersTable marketId={marketId} />}
        {STATIC_TABS.includes(activeTab) && <EmptyState tab={activeTab} />}
      </div>
    </div>
  );
}

function EmptyState({ tab }: { tab: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#8a8f97]">
      <div className="opacity-50">
        <KryonMark />
      </div>
      <span className="text-[#8a8f97] text-[13px]">No {tab.toLowerCase()} yet</span>
    </div>
  );
}
