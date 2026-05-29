import { MARKETS } from "@/config";
import { redirect } from "next/navigation";
import { MarketHeader } from "@/features/trade/components/MarketHeader";
import { TradeChart } from "@/features/trade/components/TradeChart";
import { OrderBook } from "@/features/trade/components/OrderBook";
import { OrderEntry } from "@/features/trade/components/OrderEntry";
import { BottomPanel } from "@/features/trade/components/BottomPanel";
import { AccountBar } from "@/features/trade/components/AccountBar";
import { MarketDataProvider } from "@/features/trade/components/MarketDataProvider";
import { SettlementModal } from "@/features/trade/components/SettlementModal";
import { TopNav, KryonMark } from "@/components/common/TopNav";

export default async function TradePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  const marketConfig = MARKETS[market.toUpperCase()];
  if (!marketConfig) redirect("/trade/XLM-PERP");

  return (
    <MarketDataProvider marketId={marketConfig.marketId}>
      <SettlementModal />

      {/* Small screens: the terminal is desktop-first — show a notice instead */}
      <div
        className="flex lg:hidden h-screen w-full flex-col items-center justify-center gap-4 bg-black px-8 text-center"
        style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        <KryonMark />
        <div className="text-[16px] font-semibold text-[#e6e6e6]">Kryon is built for larger screens</div>
        <div className="max-w-[320px] text-[13px] leading-relaxed text-[#8a8f97]">
          The trading terminal isn&rsquo;t optimized for phones yet. Open Kryon on a desktop, Mac, or a tablet in landscape.
        </div>
      </div>

      <div
        className="hidden lg:flex lg:flex-col h-screen overflow-hidden"
        style={{ background: "#000000", fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        {/* ── Top nav ── */}
        <TopNav />

        {/* ── Main grid ── */}
        <div
          className="flex-1 min-h-0 p-[5px]"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) 300px 360px",
            gridTemplateRows: "auto 1fr auto",
            gridTemplateAreas: '"info book ticket" "chart book ticket" "pos pos ticket"',
            gap: "5px",
          }}
        >
          {/* Market info */}
          <div style={{ gridArea: "info" }}>
            <MarketHeader market={marketConfig} />
          </div>

          {/* Chart */}
          <div style={{ gridArea: "chart" }} className="min-h-0 h-full">
            <TradeChart symbol={marketConfig.tvSymbol} marketId={marketConfig.marketId} />
          </div>

          {/* Positions / history */}
          <div style={{ gridArea: "pos" }}>
            <BottomPanel marketId={marketConfig.marketId} />
          </div>

          {/* Order book */}
          <div
            style={{ gridArea: "book" }}
            className="min-h-0 flex flex-col overflow-hidden rounded-xl border border-[#1f232a] bg-[#0f1217]"
          >
            <OrderBook marketId={marketConfig.marketId} />
          </div>

          {/* Order ticket */}
          <div
            style={{ gridArea: "ticket" }}
            className="relative overflow-y-auto rounded-xl border border-[#222226] bg-[#141416]"
          >
            <AccountBar />
            <OrderEntry market={marketConfig} />
          </div>
        </div>
      </div>
    </MarketDataProvider>
  );
}
