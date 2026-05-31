"use client";

import { AccountBar } from "@/features/trade/components/AccountBar";
import { BottomPanel } from "@/features/trade/components/BottomPanel";
import { MarketHeader } from "@/features/trade/components/MarketHeader";
import { OrderBook } from "@/features/trade/components/OrderBook";
import { OrderEntry } from "@/features/trade/components/OrderEntry";
import { TradeChart } from "@/features/trade/components/TradeChart";
import { useTradeSettings } from "@/stores/settings";
import type { MarketConfig } from "@/config";

export function TradeTerminalGrid({ market }: { market: MarketConfig }) {
  const hideOrderBook = useTradeSettings((s) => s.hideOrderBook);

  return (
    <div
      className="flex-1 min-h-0 p-0"
      style={{
        display: "grid",
        gridTemplateColumns: hideOrderBook ? "minmax(0,1fr) 360px" : "minmax(0,1fr) 270px 360px",
        gridTemplateRows: "auto 1fr auto",
        gridTemplateAreas: hideOrderBook
          ? '"info ticket" "chart ticket" "pos ticket"'
          : '"info book ticket" "chart book ticket" "pos pos ticket"',
        gap: 0,
      }}
    >
      <div style={{ gridArea: "info" }}>
        <MarketHeader market={market} />
      </div>

      <div style={{ gridArea: "chart" }} className="min-h-0 h-full">
        <TradeChart symbol={market.tvSymbol} marketId={market.marketId} />
      </div>

      <div style={{ gridArea: "pos" }}>
        <BottomPanel marketId={market.marketId} />
      </div>

      {!hideOrderBook && (
        <div
          style={{ gridArea: "book" }}
          className="min-h-0 flex flex-col overflow-hidden rounded-none border border-[#2A2A31] bg-[#19191A]"
        >
          <OrderBook marketId={market.marketId} />
        </div>
      )}

      <div
        style={{ gridArea: "ticket" }}
        className="relative overflow-y-auto rounded-none border border-[#2A2A31] bg-[#19191A]"
      >
        <AccountBar />
        <OrderEntry market={market} />
      </div>
    </div>
  );
}
