"use client";

import { useState } from "react";
import { useMarketStore } from "@/store/market";
import type { OrderBookLevel } from "@/lib/orders/matcher";

const SwapIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 7h13l-3-3M17 17H4l3 3" />
  </svg>
);
const LinesIcon = () => (
  <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M4 6h12M4 12h16M4 18h8" />
  </svg>
);
const CaretIcon = () => (
  <svg width={9} height={9} viewBox="0 0 12 12" fill="currentColor">
    <path d="M2 4 L6 8 L10 4 Z" />
  </svg>
);

type HoverState = { side: "ask" | "bid"; idx: number } | null;

interface LevelWithCum extends OrderBookLevel {
  cum: number;
}

export function OrderBook({ marketId }: { marketId: number }) {
  const [activeTab, setActiveTab] = useState<"Order Book" | "Trades">("Order Book");
  const [hover, setHover] = useState<HoverState>(null);

  const { orderBooks, recentTrades, wsConnected } = useMarketStore();
  const book = orderBooks[marketId];
  const trades = recentTrades[marketId] ?? [];

  // Compute cumulative depth from spread outward
  const rawAsks = book?.asks.slice(0, 14) ?? [];
  const rawBids = book?.bids.slice(0, 14) ?? [];

  let runA = 0;
  const asks: LevelWithCum[] = rawAsks.map((a) => {
    runA += parseFloat(a.size);
    return { ...a, cum: runA };
  });

  let runB = 0;
  const bids: LevelWithCum[] = rawBids.map((b) => {
    runB += parseFloat(b.size);
    return { ...b, cum: runB };
  });

  const maxA = asks.length ? asks[asks.length - 1].cum : 1;
  const maxB = bids.length ? bids[bids.length - 1].cum : 1;

  // Asks displayed highest-to-lowest (so best ask is closest to spread row)
  const displayAsks = [...asks].reverse();

  const spreadAbs =
    rawAsks[0] && rawBids[0]
      ? (parseFloat(rawAsks[0].price) - parseFloat(rawBids[0].price)).toFixed(4)
      : null;
  const midPrice =
    rawAsks[0] && rawBids[0]
      ? (parseFloat(rawAsks[0].price) + parseFloat(rawBids[0].price)) / 2
      : null;
  const spreadPct =
    spreadAbs && midPrice
      ? ((parseFloat(spreadAbs) / midPrice) * 100).toFixed(3) + "%"
      : "0.000%";

  const tabCls = (active: boolean) =>
    `flex-1 py-[14px] text-center text-[13.5px] font-medium relative transition-colors ${
      active
        ? "text-[#e6e6e6] after:content-[''] after:absolute after:left-[24%] after:right-[24%] after:bottom-[-1px] after:h-[2px] after:bg-[#f4f4f4] after:rounded-[2px]"
        : "text-[#8a8f97] hover:text-[#e6e6e6]"
    }`;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Tabs */}
      <div className="flex border-b border-[#1f232a] shrink-0">
        {(["Order Book", "Trades"] as const).map((t) => (
          <button key={t} className={tabCls(activeTab === t)} onClick={() => setActiveTab(t)}>
            {t}
          </button>
        ))}
      </div>

      {activeTab === "Order Book" ? (
        <>
          {/* Sub-controls */}
          <div className="flex items-center justify-between px-[14px] py-[9px] border-b border-[#1f232a] shrink-0 font-mono text-[11.5px] text-[#8a8f97]">
            <div className="flex items-center gap-[6px]">
              <button className="flex items-center gap-[6px] hover:text-[#e6e6e6] transition-colors">
                0.0001 <CaretIcon />
              </button>
              {wsConnected && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[#1fae5b]"
                  style={{ boxShadow: "0 0 4px rgba(31,174,91,0.6)" }}
                  title="Live via WebSocket"
                />
              )}
            </div>
            <div className="flex items-center gap-[10px]">
              <button className="flex items-center gap-[5px] hover:text-[#e6e6e6] transition-colors">
                USDC <SwapIcon />
              </button>
              <button className="hover:text-[#e6e6e6] transition-colors">
                <LinesIcon />
              </button>
            </div>
          </div>

          {/* Column headers */}
          <div
            className="grid grid-cols-3 px-[14px] py-[7px] font-mono text-[11px] text-[#8a8f97] border-b border-[#1f232a] shrink-0"
            style={{ letterSpacing: ".02em" }}
          >
            <span>Price USDC</span>
            <span className="text-right">Size XLM</span>
            <span className="text-right">Total XLM</span>
          </div>

          {/* Asks — reversed display (highest at top, best ask near spread) */}
          <div className="flex-1 overflow-y-auto flex flex-col-reverse" style={{ scrollbarWidth: "none" }}>
            {displayAsks.length === 0 ? (
              <EmptyRows count={8} side="ask" />
            ) : (
              displayAsks.map((a, displayIdx) => {
                const originalIdx = asks.length - 1 - displayIdx;
                const hl = hover?.side === "ask" && originalIdx <= (asks.length - 1 - (hover?.idx ?? 0));
                return (
                  <BookRow
                    key={displayIdx}
                    level={a}
                    side="ask"
                    maxCum={maxA}
                    highlight={hl}
                    onEnter={() => setHover({ side: "ask", idx: displayIdx })}
                    onLeave={() => setHover(null)}
                  />
                );
              })
            )}
          </div>

          {/* Spread row */}
          <div
            className="grid grid-cols-3 px-[14px] py-[9px] bg-[#14171c] font-mono text-[12px] shrink-0"
            style={{ borderBlock: "1px solid #1f232a" }}
          >
            <span className="font-medium text-[#e6e6e6]">{spreadAbs ?? "—"}</span>
            <span className="text-center text-[#8a8f97]">Spread</span>
            <span className="text-right text-[#8a8f97]">{spreadPct}</span>
          </div>

          {/* Bids */}
          <div className="flex-1 overflow-y-auto flex flex-col" style={{ scrollbarWidth: "none" }}>
            {bids.length === 0 ? (
              <EmptyRows count={8} side="bid" />
            ) : (
              bids.map((b, i) => {
                const hl = hover?.side === "bid" && i <= (hover?.idx ?? -1);
                return (
                  <BookRow
                    key={i}
                    level={b}
                    side="bid"
                    maxCum={maxB}
                    highlight={hl}
                    onEnter={() => setHover({ side: "bid", idx: i })}
                    onLeave={() => setHover(null)}
                  />
                );
              })
            )}
          </div>
        </>
      ) : (
        /* Trades tab */
        <div className="flex flex-col flex-1 overflow-hidden">
          <div
            className="grid grid-cols-3 px-[14px] py-[7px] font-mono text-[11px] text-[#8a8f97] border-b border-[#1f232a] shrink-0"
            style={{ letterSpacing: ".02em" }}
          >
            <span>Price USDC</span>
            <span className="text-right">Size XLM</span>
            <span className="text-right">Time</span>
          </div>
          <div className="flex-1 overflow-y-auto" style={{ scrollbarWidth: "none" }}>
            {trades.length === 0 ? (
              <div className="flex items-center justify-center h-16">
                <span className="text-[11px] text-[#5a5f66]">No trades yet</span>
              </div>
            ) : (
              trades.map((t, i) => (
                <div
                  key={i}
                  className="grid grid-cols-3 px-[14px] font-mono text-[12px] hover:bg-white/[0.02] cursor-pointer"
                  style={{ padding: "4.5px 14px" }}
                >
                  <span className={t.side === "buy" ? "text-[#1fae5b]" : "text-[#e34c4c]"}>
                    {parseFloat(t.price).toFixed(4)}
                  </span>
                  <span className="text-right text-[#e6e6e6]">
                    {parseFloat(t.size).toLocaleString()}
                  </span>
                  <span className="text-right text-[#8a8f97]">
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
      )}
    </div>
  );
}

function BookRow({
  level,
  side,
  maxCum,
  highlight,
  onEnter,
  onLeave,
}: {
  level: LevelWithCum;
  side: "ask" | "bid";
  maxCum: number;
  highlight: boolean;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const barPct = (level.cum / maxCum) * 100;
  const priceF = parseFloat(level.price);
  const sizeF = parseFloat(level.size);

  return (
    <div
      className="relative grid grid-cols-3 font-mono text-[12px] cursor-pointer hover:bg-white/[0.03]"
      style={{ padding: "3.5px 14px", lineHeight: 1.45 }}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      {/* Depth bar */}
      <div
        className={`absolute top-0 bottom-0 right-0 ${
          side === "ask" ? "bg-[rgba(227,76,76,0.12)]" : "bg-[rgba(31,174,91,0.12)]"
        }`}
        style={{ width: `${barPct}%` }}
      />
      {/* Cumulative highlight line */}
      {highlight && (
        <div className="absolute left-0 right-0 top-0 h-[1px] bg-[#f4f4f4] opacity-60 z-10" />
      )}
      <span className={`relative z-10 ${side === "ask" ? "text-[#e34c4c]" : "text-[#1fae5b]"}`}>
        {priceF.toFixed(4)}
      </span>
      <span className="relative z-10 text-right text-[#e6e6e6]">
        {sizeF >= 1000
          ? sizeF.toLocaleString("en-US", { maximumFractionDigits: 0 })
          : sizeF.toFixed(2)}
      </span>
      <span className="relative z-10 text-right text-[#e6e6e6]">
        {level.cum >= 1000
          ? Math.round(level.cum).toLocaleString("en-US")
          : level.cum.toFixed(2)}
      </span>
    </div>
  );
}

function EmptyRows({ count, side }: { count: number; side: "ask" | "bid" }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} style={{ padding: "3.5px 14px", lineHeight: 1.45 }} className="flex items-center">
          <div
            className={`h-[5px] rounded-full w-10 opacity-[0.06] ${
              side === "ask" ? "bg-[#e34c4c]" : "bg-[#1fae5b]"
            }`}
          />
        </div>
      ))}
    </>
  );
}
