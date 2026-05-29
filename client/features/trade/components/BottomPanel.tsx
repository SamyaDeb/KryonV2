"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { getPositions } from "@/lib/stellar/contracts";
import { MARKETS } from "@/config";
import { useOrderReconciliation } from "@/features/trade/hooks/useOrderReconciliation";
import { PositionsTable } from "./PositionsTable";
import { OpenOrdersTable } from "./OpenOrdersTable";
import { OrderHistoryTable } from "./OrderHistoryTable";
import { TradeHistoryTable } from "./TradeHistoryTable";

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
      <path d="M16 2 L29 9 L29 23 L16 30 L3 23 L3 9 Z" stroke="#f7931a" strokeWidth="1.8" />
      <path d="M16 9 L23 13 L23 19 L16 23 L9 19 L9 13 Z" fill="#f7931a" />
      <path
        d="M16 2 L16 30 M3 9 L29 23 M29 9 L3 23"
        stroke="#f7931a"
        strokeWidth="0.6"
        opacity={0.35}
      />
    </svg>
  );
}

type TabKey = "Positions" | "Open Orders" | "Trade History" | "Order History" | "Funding History";

export function BottomPanel({ marketId }: { marketId: number }) {
  useOrderReconciliation();
  const [activeTab, setActiveTab] = useState<TabKey>("Positions");
  const [marketFilter, setMarketFilter] = useState<number | "all">(marketId);
  const [sideFilter, setSideFilter] = useState<"both" | "long" | "short">("both");
  const [marketMenu, setMarketMenu] = useState(false);
  const [sideMenu, setSideMenu] = useState(false);
  const { address, connected } = useWalletStore();
  const allOrders = useLocalOrders((s) => s.orders);

  // Shared positions query (same key as PositionsTable — cache hit, no double-fetch)
  const { data: allPositions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const matchMarket = (mId: number) => marketFilter === "all" || mId === marketFilter;
  const matchSide = (isLong: boolean) => sideFilter === "both" || (sideFilter === "long") === isLong;

  const positionCount = allPositions.filter((p) => matchMarket(p.marketId) && matchSide(p.isLong)).length;
  const orderCount = allOrders.filter((o) => o.status === "pending" && matchMarket(o.marketId) && matchSide(o.isLong)).length;
  const orderHistoryCount = allOrders.filter((o) => matchMarket(o.marketId) && matchSide(o.isLong)).length;

  const marketLabel =
    marketFilter === "all" ? "All" : Object.values(MARKETS).find((m) => m.marketId === marketFilter)?.symbol ?? "All";
  const sideLabel = sideFilter === "both" ? "Both" : sideFilter === "long" ? "Long" : "Short";

  const TABS: { key: TabKey; count: number | null }[] = [
    { key: "Positions", count: positionCount },
    { key: "Open Orders", count: orderCount },
    { key: "Trade History", count: null },
    { key: "Order History", count: orderHistoryCount },
    { key: "Funding History", count: null },
  ];

  const tabCls = (active: boolean) =>
    `px-4 py-[14px] text-[13px] font-medium relative transition-colors ${
      active
        ? "text-[#e6e6e6] after:content-[''] after:absolute after:left-[14px] after:right-[14px] after:bottom-[-1px] after:h-[2px] after:bg-[#f7931a] after:rounded-[2px]"
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
          {/* Market filter */}
          <div className="relative">
            <button
              onClick={() => { setMarketMenu((v) => !v); setSideMenu(false); }}
              className="flex items-center gap-2 px-3 py-[7px] rounded-[7px] bg-[#14171c] border border-[#1f232a] text-[12.5px] text-[#8a8f97] hover:border-[#2a2f37] hover:text-[#e6e6e6] transition-colors"
            >
              Market <span className="text-[#e6e6e6] font-medium">{marketLabel}</span>
              <CaretIcon />
            </button>
            {marketMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMarketMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-[160px] rounded-[8px] border border-[#1f232a] bg-[#0f1217] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                  <MenuItem active={marketFilter === "all"} onClick={() => { setMarketFilter("all"); setMarketMenu(false); }}>All markets</MenuItem>
                  {Object.values(MARKETS).map((m) => (
                    <MenuItem key={m.marketId} active={marketFilter === m.marketId} onClick={() => { setMarketFilter(m.marketId); setMarketMenu(false); }}>
                      {m.symbol}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
          </div>
          {/* Side filter */}
          <div className="relative">
            <button
              onClick={() => { setSideMenu((v) => !v); setMarketMenu(false); }}
              className="flex items-center gap-2 px-3 py-[7px] rounded-[7px] bg-[#14171c] border border-[#1f232a] text-[12.5px] text-[#8a8f97] hover:border-[#2a2f37] hover:text-[#e6e6e6] transition-colors"
            >
              <LinesIcon />
              <span className="text-[#e6e6e6] font-medium">{sideLabel}</span>
              <CaretIcon />
            </button>
            {sideMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setSideMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 w-[120px] rounded-[8px] border border-[#1f232a] bg-[#0f1217] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                  {(["both", "long", "short"] as const).map((s) => (
                    <MenuItem key={s} active={sideFilter === s} onClick={() => { setSideFilter(s); setSideMenu(false); }}>
                      {s === "both" ? "Both" : s === "long" ? "Long" : "Short"}
                    </MenuItem>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="overflow-y-auto" style={{ maxHeight: 180 }}>
        {activeTab === "Positions" && <PositionsTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Open Orders" && <OpenOrdersTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Trade History" && <TradeHistoryTable marketFilter={marketFilter} />}
        {activeTab === "Order History" && <OrderHistoryTable marketFilter={marketFilter} sideFilter={sideFilter} />}
        {activeTab === "Funding History" && <EmptyState tab="Funding History" />}
      </div>
    </div>
  );
}

function MenuItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`block w-full text-left px-3 py-[6px] rounded-[5px] text-[12.5px] transition-colors ${
        active ? "text-[#f7931a]" : "text-[#8a8f97] hover:text-[#e6e6e6] hover:bg-[#14171c]"
      }`}
    >
      {children}
    </button>
  );
}

function EmptyState({ tab }: { tab: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#8a8f97]">
      <div className="opacity-50">
       
      </div>
      <span className="text-[#8a8f97] text-[13px]">No {tab.toLowerCase()} yet</span>
    </div>
  );
}
