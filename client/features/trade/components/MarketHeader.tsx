"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ACTIVE_MARKETS, MarketConfig } from "@/config";
import { getOpenInterest } from "@/lib/stellar/contracts";
import { formatAmount, formatChangePercent, priceToHuman } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { useTradeSettings } from "@/stores/settings";
import { XlmLogo } from "@/components/common/AssetLogos";

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

export function MarketHeader({ market }: { market: MarketConfig }) {
  const router = useRouter();
  const [pairOpen, setPairOpen] = useState(false);
  const markPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const stats = useMarketStore((s) => s.marketStats[market.marketId]);
  const ticker24h = useMarketStore((s) => s.ticker24h[market.marketId]);
  const changePct = useMarketStore((s) => s.priceChangePct[market.marketId]);
  const degenMode = useTradeSettings((s) => s.degenMode);

  const { data: oi } = useQuery({
    queryKey: ["oi", market.marketId],
    queryFn: () => getOpenInterest(market.marketId),
    refetchInterval: 15_000,
  });

  const markHuman = markPrice ? priceToHuman(markPrice) : null;

  // 24h volume: prefer indexer stats (already in 1e18 units from last_price),
  // fall back to on-chain OI sum as proxy
  const volumeDisplay = stats
    ? "$" + formatAmount(stats.volume, 0)
    : oi
    ? "$" + formatAmount(oi.total, 0)
    : "—";

  const displayPrice = stats && stats.lastPrice > 0n
    ? "$" + priceToHuman(stats.lastPrice).toFixed(4)
    : markHuman !== null
    ? "$" + markHuman.toFixed(4)
    : "—";

  const baseSymbol = market.symbol.replace("-PERP", "");
  const activeMarkets = Object.values(ACTIVE_MARKETS);
  const canSwitchMarkets = activeMarkets.length > 1;
  const leverageDisplay = degenMode ? 500 : Math.round(market.maxLeverageBps / 10_000);

  const changeDisplay = changePct !== undefined
    ? formatChangePercent(changePct)
    : "—";
  const changeUp = changePct === undefined || changePct >= 0;
  const highDisplay = ticker24h?.highPrice && ticker24h.highPrice > 0n
    ? "$" + priceToHuman(ticker24h.highPrice).toFixed(4)
    : "—";
  const lowDisplay = ticker24h?.lowPrice && ticker24h.lowPrice > 0n
    ? "$" + priceToHuman(ticker24h.lowPrice).toFixed(4)
    : "—";

  const statItems: Array<{ label: string; value: string; tone?: "up" | "down" }> = [
    { label: "24h High", value: highDisplay },
    { label: "24h Low", value: lowDisplay },
    { label: "24h Change", value: changeDisplay, tone: changeUp ? "up" : "down" },
    { label: "24h Volume", value: volumeDisplay },
  ];

  return (
    <div className="flex h-[40px] items-center overflow-x-auto rounded-none border border-[#2A2A31] bg-[#19191A]" style={{ scrollbarWidth: "none" }}>
      {/* Pair selector — switches market */}
      <div className="relative flex h-full shrink-0 items-center gap-2 px-3">
        <div className="flex items-center gap-[9px]">
          {canSwitchMarkets ? (
            <button
              type="button"
              className="flex items-center gap-[7px] transition-opacity hover:opacity-90"
              onClick={() => setPairOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={pairOpen}
            >
              <MarketPairLabel baseSymbol={baseSymbol} quoteAsset={market.quoteAsset} />
              <span className="text-[#a3a3a3]">
                <CaretIcon />
              </span>
            </button>
          ) : (
            <MarketPairLabel baseSymbol={baseSymbol} quoteAsset={market.quoteAsset} />
          )}
          <span className={`rounded-[5px] border px-2 py-[2px] font-mono text-[11.5px] font-semibold ${
            degenMode
              ? "border-[#e2a9f1]/50 bg-[#e2a9f1]/15 text-[#e2a9f1]"
              : "border-[#334155] bg-[#212128] text-[#f5f5f5]"
          }`}>
            {leverageDisplay}X
          </span>
        </div>
        {canSwitchMarkets && pairOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPairOpen(false)} />
            <div className="absolute left-0 top-full mt-2 z-50 w-[220px] rounded-[10px] border border-[#334155] bg-[#19191A] shadow-[0_20px_40px_rgba(0,0,0,.6)] overflow-hidden">
              {activeMarkets.map((m) => (
                <button
                  key={m.marketId}
                  onClick={() => { setPairOpen(false); if (m.marketId !== market.marketId) router.push(`/trade/${m.symbol}`); }}
                  className={`flex w-full items-center justify-between px-3 py-[10px] text-left hover:bg-[#2A2A31] transition-colors ${
                    m.marketId === market.marketId ? "bg-[#2A2A31]" : ""
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <XlmLogo size={18} />
                    <span className="text-[13px] font-semibold text-[#f5f5f5]">{m.symbol}</span>
                  </span>
                  <span className="font-mono text-[11px] text-[#a3a3a3]">{Math.round(m.maxLeverageBps / 10000)}x</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="flex h-full shrink-0 items-center px-3">
        <span
          className="font-mono text-[15px] font-semibold text-[#f5f5f5]"
        >
          {displayPrice}
        </span>
      </div>

      {/* Stats strip */}
      <div className="flex h-full min-w-0 flex-1 items-center gap-5 px-2">
        {statItems.map((s, i) => (
          <div
            key={i}
            className={`flex h-full shrink-0 flex-col justify-center gap-[2px] ${
              i === statItems.length - 1 ? "min-w-[76px]" : "min-w-[68px]"
            }`}
          >
            <span className="text-[9.5px] font-semibold text-[#737373] whitespace-nowrap">{s.label}</span>
            <span
              className={`font-mono text-[12.5px] font-semibold ${
                s.tone
                  ? s.tone === "up"
                    ? "text-[#1fae5b]"
                    : "text-[#ff4d5f]"
                  : "text-[#f5f5f5]"
              }`}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MarketPairLabel({ baseSymbol, quoteAsset }: { baseSymbol: string; quoteAsset: string }) {
  return (
    <span className="flex items-center gap-[7px]">
      <XlmLogo size={19} />
      <span className="flex items-center gap-[3px] text-[15px] font-semibold text-[#f5f5f5]" style={{ letterSpacing: ".01em" }}>
        {baseSymbol}
        <span className="text-[#737373] font-normal">/</span>
        <span>{quoteAsset}</span>
      </span>
    </span>
  );
}
