"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchRecentTrades } from "@/lib/orders/matcher";

export function TradesFeed({ marketId }: { marketId: number }) {
  const { data: trades = [] } = useQuery({
    queryKey: ["trades", marketId],
    queryFn: () => fetchRecentTrades(marketId),
    refetchInterval: 3_000,
  });

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="px-3 py-2 shrink-0">
        <span className="text-[11px] font-semibold text-[#7b88a8] uppercase tracking-widest">Trades</span>
      </div>

      <div className="grid grid-cols-3 px-3 pb-1.5 shrink-0">
        <span className="text-[10px] text-[#3d4f6b]">Price</span>
        <span className="text-[10px] text-[#3d4f6b] text-right">Size</span>
        <span className="text-[10px] text-[#3d4f6b] text-right">Time</span>
      </div>

      <div className="flex-1 overflow-y-auto">
        {trades.length === 0 ? (
          <div className="flex items-center justify-center h-12">
            <span className="text-[11px] text-[#3d4f6b]">No trades yet</span>
          </div>
        ) : (
          trades.map((t, i) => (
            <div
              key={i}
              className="grid grid-cols-3 px-3 h-[18px] items-center hover:bg-white/[0.03]"
            >
              <span
                className={`text-[11px] tabular font-medium ${
                  t.side === "buy" ? "text-[#00d48a]" : "text-[#ff3858]"
                }`}
              >
                {parseFloat(t.price).toFixed(4)}
              </span>
              <span className="text-[11px] tabular text-[#8891b8] text-right">
                {parseFloat(t.size).toFixed(2)}
              </span>
              <span className="text-[11px] tabular text-[#4a5570] text-right">
                {new Date(t.timestamp).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
