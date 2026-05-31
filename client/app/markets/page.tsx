import Link from "next/link";
import { ACTIVE_MARKETS } from "@/config";
import { UsdcLogo, XlmLogo } from "@/components/common/AssetLogos";
import { TopNav } from "@/components/common/TopNav";

function leverageLabel(bps: number) {
  return `${Math.round(bps / 10_000)}x`;
}

export default function MarketsPage() {
  const markets = Object.values(ACTIVE_MARKETS);

  return (
    <main
      className="min-h-screen bg-[#19191A] text-[#f5f5f5]"
      style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}
    >
      <TopNav />
      <section className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-6 py-8">
        <div className="flex items-end justify-between gap-4">
          <div>
            <h1 className="text-[24px] font-semibold tracking-[.01em]">Markets</h1>
            <p className="mt-1 text-[13px] text-[#a3a3a3]">Active perpetual markets available for trading.</p>
          </div>
          <div className="rounded-[6px] border border-[#2A2A31] bg-[#212128] px-3 py-2 text-[12px] text-[#a3a3a3]">
            {markets.length} active
          </div>
        </div>

        <div className="overflow-hidden rounded-[10px] border border-[#2A2A31] bg-[#212128]">
          <div className="grid grid-cols-[1.4fr_.8fr_.8fr_.8fr_.8fr_.8fr] border-b border-[#2A2A31] px-4 py-3 text-[11px] uppercase tracking-[.08em] text-[#737373]">
            <div>Market</div>
            <div>Collateral</div>
            <div>Leverage</div>
            <div>Initial Margin</div>
            <div>Maintenance</div>
            <div className="text-right">Action</div>
          </div>
          {markets.map((market) => (
            <div
              key={market.symbol}
              className="grid grid-cols-[1.4fr_.8fr_.8fr_.8fr_.8fr_.8fr] items-center border-b border-[#2A2A31] px-4 py-4 last:border-b-0 hover:bg-white/[0.02] transition-colors"
            >
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-2 text-[14px] font-semibold">
                  {market.baseAsset === "XLM" ? <XlmLogo size={18} /> : null}
                  {market.symbol}
                </span>
                <span className="text-[12px] text-[#a3a3a3]">{market.baseAsset} perpetual settled in {market.quoteAsset}</span>
              </div>
              <div className="flex items-center gap-2 text-[13px] text-[#f5f5f5]">
                {market.quoteAsset === "USDC" ? <UsdcLogo size={14} /> : null}
                {market.quoteAsset}
              </div>
              <div className="font-mono text-[13px] text-[#f5f5f5]">{leverageLabel(market.maxLeverageBps)}</div>
              <div className="font-mono text-[13px] text-[#f5f5f5]">{(market.initialMarginBps / 100).toFixed(2)}%</div>
              <div className="font-mono text-[13px] text-[#f5f5f5]">{(market.maintenanceMarginBps / 100).toFixed(2)}%</div>
              <div className="text-right">
                <Link
                  href={`/trade/${market.symbol}`}
                  className="inline-flex rounded-[6px] border border-[#2A2A31] bg-[#19191A] px-3 py-2 text-[12px] font-semibold text-[#f5f5f5] transition-colors hover:border-[#475569]"
                >
                  Trade
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
