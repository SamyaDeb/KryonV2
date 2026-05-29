"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { MarketConfig, MARKETS } from "@/config";
import { getOpenInterest, getFundingState } from "@/lib/stellar/contracts";
import { formatAmount, formatFundingRate, formatChangePercent, priceToHuman } from "@/lib/format";
import { useMarketStore } from "@/stores/market";
import { XlmLogo, UsdcLogo } from "@/components/common/AssetLogos";

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
  const changePct = useMarketStore((s) => s.priceChangePct[market.marketId]);

  // Funding settles hourly — count down to the next UTC hour boundary.
  // Start at 0 so SSR and first client render match (avoids hydration mismatch).
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const fundingCountdown = (() => {
    const remainMs = 3_600_000 - (now % 3_600_000);
    const s = Math.floor(remainMs / 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  })();

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
  const baseSymbol = market.symbol.replace("-PERP", "");

  // OI from indexer stats or on-chain contract read
  const oiLong = stats ? stats.longOI : oi?.long;
  const oiShort = stats ? stats.shortOI : oi?.short;
  const oiDisplay = oiLong !== undefined && oiShort !== undefined
    ? "$" + formatAmount(oiLong + oiShort, 0)
    : "—";

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
      l: "Index",
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
      sub: now ? fundingCountdown : undefined,
    },
  ];

  return (
    <div
      className="flex items-center gap-[20px] px-[14px] py-[8px] rounded-xl border border-[#1f232a] bg-[#0f1217] overflow-x-auto"
      style={{ scrollbarWidth: "none" }}
    >
      {/* Pair selector — switches market */}
      <div className="relative pr-[24px] border-r border-[#1f232a] shrink-0">
        <button
          className="flex items-center gap-[10px] hover:opacity-90 transition-opacity"
          onClick={() => setPairOpen((v) => !v)}
        >
          <XlmLogo size={26} />
          <span className="flex items-center gap-[5px] font-semibold text-[15px] text-[#e6e6e6]" style={{ letterSpacing: ".02em" }}>
            {baseSymbol}
            <span className="text-[#5a5f66] font-normal">/</span>
            <UsdcLogo size={14} />
            <span className="text-[#8a8f97] text-[13px] font-medium">{market.quoteAsset}</span>
          </span>
          <span className="text-[#8a8f97]">
            <CaretIcon />
          </span>
        </button>
        {pairOpen && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setPairOpen(false)} />
            <div className="absolute left-0 top-full mt-2 z-50 w-[220px] rounded-[10px] border border-[#1f232a] bg-[#0f1217] shadow-[0_20px_40px_rgba(0,0,0,.6)] overflow-hidden">
              {Object.values(MARKETS).map((m) => (
                <button
                  key={m.marketId}
                  onClick={() => { setPairOpen(false); if (m.marketId !== market.marketId) router.push(`/trade/${m.symbol}`); }}
                  className={`flex w-full items-center justify-between px-3 py-[10px] text-left hover:bg-[#14171c] transition-colors ${
                    m.marketId === market.marketId ? "bg-[#14171c]" : ""
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <XlmLogo size={18} />
                    <span className="text-[13px] font-semibold text-[#e6e6e6]">{m.symbol}</span>
                  </span>
                  <span className="font-mono text-[11px] text-[#8a8f97]">{Math.round(m.maxLeverageBps / 10000)}x</span>
                </button>
              ))}
            </div>
          </>
        )}
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
              {(s as { sub?: string }).sub && (
                <span className="text-[#5a5f66] ml-[6px]">{(s as { sub?: string }).sub}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
