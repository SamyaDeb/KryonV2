import { ACTIVE_MARKETS, DEFAULT_MARKET_SYMBOL } from "@/config";
import { redirect } from "next/navigation";
import { MarketDataProvider } from "@/features/trade/components/MarketDataProvider";
import { SettlementModal } from "@/features/trade/components/SettlementModal";
import Image from "next/image";
import { TopNav } from "@/components/common/TopNav";
import { TradeTerminalGrid } from "@/features/trade/components/TradeTerminalGrid";

export default async function TradePage({
  params,
}: {
  params: Promise<{ market: string }>;
}) {
  const { market } = await params;
  const marketConfig = ACTIVE_MARKETS[market.toUpperCase()];
  if (!marketConfig) redirect(`/trade/${DEFAULT_MARKET_SYMBOL}`);

  return (
    <MarketDataProvider marketId={marketConfig.marketId}>
      <SettlementModal />

      {/* Small screens: the terminal is desktop-first — show a notice instead */}
      <div
        className="flex lg:hidden h-screen w-full flex-col items-center justify-center gap-4 bg-[#19191A] px-8 text-center"
        style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        <Image src="/logo.png" alt="Kryon" width={80} height={80} className="object-contain" />
        <div className="text-[16px] font-semibold text-[#f5f5f5]">Kryon is built for larger screens</div>
        <div className="max-w-[320px] text-[13px] leading-relaxed text-[#a3a3a3]">
          The trading terminal isn&rsquo;t optimized for phones yet. Open Kryon on a desktop, Mac, or a tablet in landscape.
        </div>
      </div>

      <div
        className="hidden lg:flex lg:flex-col h-screen overflow-hidden"
        style={{ background: "#19191A", fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
      >
        {/* ── Top nav ── */}
        <TopNav />

        <TradeTerminalGrid market={marketConfig} />
      </div>
    </MarketDataProvider>
  );
}
