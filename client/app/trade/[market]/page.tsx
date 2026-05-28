import { MARKETS } from "@/lib/config";
import { redirect } from "next/navigation";
import { MarketHeader } from "@/components/trade/MarketHeader";
import { TradeChart } from "@/components/trade/TradeChart";
import { OrderBook } from "@/components/trade/OrderBook";
import { OrderEntry } from "@/components/trade/OrderEntry";
import { BottomPanel } from "@/components/trade/BottomPanel";
import { WalletConnect } from "@/components/trade/WalletConnect";
import { AccountBar } from "@/components/trade/AccountBar";
import { MarketDataProvider } from "@/components/trade/MarketDataProvider";
import { SettlementModal } from "@/components/trade/SettlementModal";
import { Bell } from "lucide-react";

function KryonMark() {
  return (
    <svg viewBox="0 0 32 32" fill="none" width={22} height={22}>
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

const NAV_TABS = ["Trade", "Portfolio", "Rewards", "Vaults"] as const;

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
      <div
        className="flex flex-col h-screen overflow-hidden"
        style={{ background: "#06070a", fontFamily: "'Inter', system-ui, sans-serif" }}
      >
        {/* ── Top nav ── */}
        <header className="flex items-center justify-between px-[22px] py-[14px] border-b border-[#1f232a] shrink-0">
          <div className="flex items-center gap-[34px]">
            <div className="flex items-center gap-[10px] font-bold tracking-[.18em] text-[14px] text-[#e6e6e6] select-none">
              <KryonMark />
              KRYON
            </div>
            <nav className="flex gap-[6px]">
              {NAV_TABS.map((t) => (
                <a
                  key={t}
                  href="#"
                  className={`px-[14px] py-[8px] rounded-[6px] text-[13.5px] font-medium transition-colors ${
                    t === "Trade"
                      ? "text-[#e6e6e6] bg-[#14171c]"
                      : "text-[#8a8f97] hover:text-[#e6e6e6] hover:bg-[#14171c]"
                  }`}
                >
                  {t}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-[18px]">
            {/* Account stats (balance, equity, health) — visible when connected */}
            <AccountBar />
            <WalletConnect />
            <button className="w-[34px] h-[34px] rounded-full bg-[#14171c] border border-[#1f232a] grid place-items-center text-[#8a8f97] hover:border-[#2a2f37] transition-colors">
              <Bell size={15} />
            </button>
          </div>
        </header>

        {/* ── Main grid ── */}
        <div
          className="flex-1 min-h-0 p-[10px]"
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0,1fr) 300px 360px",
            gridTemplateRows: "auto 1fr auto",
            gridTemplateAreas: '"info book ticket" "chart book ticket" "pos pos ticket"',
            gap: "10px",
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
            className="relative overflow-y-auto rounded-xl border border-[#1f232a] bg-[#0f1217]"
          >
            <OrderEntry market={marketConfig} />
          </div>
        </div>
      </div>
    </MarketDataProvider>
  );
}
