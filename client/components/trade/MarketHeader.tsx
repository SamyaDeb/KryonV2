"use client";

import { useQuery } from "@tanstack/react-query";
import { MarketConfig } from "@/lib/config";
import { getOpenInterest, getFundingState } from "@/lib/stellar/contracts";
import { formatAmount, formatFundingRate, formatChangePercent, priceToHuman } from "@/lib/format";
import { useMarketStore } from "@/store/market";

const StellarIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" width={14} height={14}>
    <circle cx="12" cy="12" r="10" fill="#0d0f13" />
    <path d="M5 9.5 L19 9.5 M5 14.5 L19 14.5 M7 7 L17 17 M17 7 L7 17" stroke="#c8ccd1" strokeWidth="1.2" opacity={0.9} />
    <circle cx="12" cy="12" r="2.2" fill="#c8ccd1" />
  </svg>
);

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

export function MarketHeader({ market }: { market: MarketConfig }) {
  const { markPrices, marketStats, priceChangePct } = useMarketStore();
  const markPrice = markPrices[market.marketId];
  const stats = marketStats[market.marketId];

  const { data: oi } = useQuery({
    queryKey: ["oi", market.marketId],
    queryFn: () => getOpenInterest(market.marketId),
    refetchInterval: 15_000,
  });

  const { data: funding } = useQuery({
    queryKey: ["funding", market.marketId],
    queryFn: () => getFundingState(market.marketId),
    refetchInterval: 30_000,
  });

  const markHuman = markPrice ? priceToHuman(markPrice) : null;

  // 24h volume: prefer indexer stats (already in 1e18 units from last_price),
  // fall back to on-chain OI sum as proxy
  const volumeDisplay = stats
    ? "$" + formatAmount(stats.volume, 0)
    : oi
    ? "$" + formatAmount(oi.total, 0)
    : "—";

  // Last fill price from indexer as the "Last" price
  const lastPriceDisplay = stats && stats.lastPrice > 0n
    ? "$" + priceToHuman(stats.lastPrice).toFixed(4)
    : markHuman !== null
    ? "$" + markHuman.toFixed(4)
    : "—";

  const fundingPositive = !funding || funding.ratePerHour >= 0n;
  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const baseSymbol = market.symbol.replace("-PERP", "");

  // OI from indexer stats or on-chain contract read
  const oiLong = stats ? stats.longOI : oi?.long;
  const oiShort = stats ? stats.shortOI : oi?.short;
  const oiDisplay = oiLong !== undefined && oiShort !== undefined
    ? "$" + formatAmount(oiLong + oiShort, 0)
    : "—";

  const changePct = priceChangePct[market.marketId];
  const changeDisplay = changePct !== undefined
    ? formatChangePercent(changePct)
    : "—";
  const changeUp = changePct === undefined || changePct >= 0;

  const statItems = [
    {
      l: "Mark",
      v: markHuman !== null ? "$" + markHuman.toFixed(4) : "—",
    },
    {
      l: "Last Price",
      v: lastPriceDisplay,
    },
    {
      l: "24h Change",
      v: changeDisplay,
      up: changeUp,
      hasColor: true,
    },
    {
      l: "24h Volume",
      v: volumeDisplay,
    },
    {
      l: "Open Interest",
      v: oiDisplay,
    },
    {
      l: "1h Funding",
      v: funding ? formatFundingRate(funding.ratePerHour) : "—",
      up: fundingPositive,
      hasColor: true,
    },
  ];

  return (
    <div
      className="flex items-center gap-[22px] px-[18px] py-[14px] rounded-xl border border-[#1f232a] bg-[#0f1217] overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {/* Pair selector */}
      <div className="flex items-center gap-[10px] pr-[24px] border-r border-[#1f232a] shrink-0">
        <div className="w-[26px] h-[26px] rounded-full bg-gradient-to-br from-[#1a1c20] to-[#2a2d33] border border-[#2a2f37] grid place-items-center">
          <StellarIcon />
        </div>
        <span className="font-semibold text-[15px] text-[#e6e6e6]" style={{ letterSpacing: ".02em" }}>
          {baseSymbol}
        </span>
        <button className="font-mono text-[11px] px-[8px] py-[3px] bg-[#14171c] border border-[#1f232a] rounded-[5px] text-[#8a8f97] hover:border-[#2a2f37] hover:text-[#e6e6e6] transition-colors">
          {maxLev}x
        </button>
        <span className="text-[#8a8f97]">
          <CaretIcon />
        </span>
      </div>

      {/* Stats strip */}
      <div className="flex items-center gap-[22px]">
        {statItems.map((s, i) => (
          <div key={i} className="flex flex-col gap-[3px] shrink-0">
            <span
              className="text-[11px] text-[#8a8f97]"
              style={{
                textDecoration: "underline",
                textDecorationColor: "#1f232a",
                textUnderlineOffset: "3px",
                textDecorationStyle: "dotted",
                cursor: "help",
              }}
            >
              {s.l}
            </span>
            <span
              className={`font-mono text-[13px] font-medium ${
                "hasColor" in s && s.hasColor
                  ? s.up
                    ? "text-[#1fae5b]"
                    : "text-[#e34c4c]"
                  : "text-[#e6e6e6]"
              }`}
            >
              {s.v}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
