"use client";

import { useState } from "react";
import { useMarketStore } from "@/stores/market";
import type { OrderBookLevel } from "@/lib/market/matcher";
import { UsdcLogo, XlmLogo } from "@/components/common/AssetLogos";

const SwapIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 7h13l-3-3M17 17H4l3 3" />
  </svg>
);
const CaretIcon = () => (
  <svg width={9} height={9} viewBox="0 0 12 12" fill="currentColor">
    <path d="M2 4 L6 8 L10 4 Z" />
  </svg>
);

const TICKS = [0.0001, 0.001, 0.01, 0.1];
type ViewMode = "both" | "asks" | "bids";

interface LevelRow {
  price: number;
  metric: number; // size in base or quote, per denomination
  cum: number;
}

// Aggregate raw book levels into price buckets of `tick`.
function groupByTick(levels: OrderBookLevel[], tick: number, isBid: boolean): { price: number; size: number }[] {
  const map = new Map<string, number>();
  for (const l of levels) {
    const p = parseFloat(l.price);
    const s = parseFloat(l.size);
    if (!isFinite(p) || !isFinite(s)) continue;
    const bucket = isBid ? Math.floor(p / tick) * tick : Math.ceil(p / tick) * tick;
    const key = bucket.toFixed(8);
    map.set(key, (map.get(key) ?? 0) + s);
  }
  const out = [...map.entries()].map(([k, size]) => ({ price: parseFloat(k), size }));
  out.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price));
  return out;
}

export function OrderBook({ marketId }: { marketId: number }) {
  const [activeTab, setActiveTab] = useState<"Order Book" | "Trades">("Order Book");
  const [hover, setHover] = useState<HoverState>(null);
  const [tickIdx, setTickIdx] = useState(0);
  const [tickOpen, setTickOpen] = useState(false);
  const [denomQuote, setDenomQuote] = useState(false); // false = base (XLM), true = quote (USDC)
  const [viewMode, setViewMode] = useState<ViewMode>("both");

  const book = useMarketStore((s) => s.orderBooks[marketId]);
  const tradesRaw = useMarketStore((s) => s.recentTrades[marketId]);
  const wsConnected = useMarketStore((s) => s.wsConnected);
  const setSelectedPrice = useMarketStore((s) => s.setSelectedPrice);
  const trades = tradesRaw ?? [];

  const tick = TICKS[tickIdx];
  const unit = denomQuote ? "USDC" : "XLM";
  const depth = viewMode === "both" ? 14 : 26;

  // Group → slice → cumulative on the chosen denomination metric.
  const toRows = (levels: { price: number; size: number }[]): LevelRow[] => {
    let run = 0;
    return levels.slice(0, depth).map(({ price, size }) => {
      const metric = denomQuote ? price * size : size;
      run += metric;
      return { price, metric, cum: run };
    });
  };

  const asks = toRows(groupByTick(book?.asks ?? [], tick, false));
  const bids = toRows(groupByTick(book?.bids ?? [], tick, true));

  const maxDepth = Math.max(
    asks.length ? asks[asks.length - 1].cum : 0,
    bids.length ? bids[bids.length - 1].cum : 0,
    1
  );

  const displayAsks = [...asks].reverse(); // highest at top, best ask near spread

  const bestAsk = asks[0]?.price ?? null;
  const bestBid = bids[0]?.price ?? null;
  const spreadAbs = bestAsk !== null && bestBid !== null ? (bestAsk - bestBid).toFixed(4) : null;
  const midPrice = bestAsk !== null && bestBid !== null ? (bestAsk + bestBid) / 2 : null;
  const spreadPct =
    spreadAbs && midPrice ? ((parseFloat(spreadAbs) / midPrice) * 100).toFixed(3) + "%" : "0.000%";

  const tabCls = (active: boolean) =>
    `flex-1 py-[14px] text-center text-[13.5px] font-medium relative transition-colors ${
      active
        ? "text-[#e6e6e6] after:content-[''] after:absolute after:left-[24%] after:right-[24%] after:bottom-[-1px] after:h-[2px] after:bg-[#f7931a] after:rounded-[2px]"
        : "text-[#8a8f97] hover:text-[#e6e6e6]"
    }`;

  const onPriceClick = (price: number) => setSelectedPrice(marketId, price);

  const Asks = (
    <div className="flex-1 overflow-y-auto flex flex-col-reverse" style={{ scrollbarWidth: "none" }}>
      {displayAsks.length === 0 ? (
        <EmptyRows count={8} side="ask" />
      ) : (
        displayAsks.map((a, displayIdx) => {
          const originalIdx = asks.length - 1 - displayIdx;
          const hl = hover?.side === "ask" && originalIdx <= asks.length - 1 - (hover?.idx ?? 0);
          return (
            <BookRow
              key={displayIdx}
              level={a}
              side="ask"
              maxCum={maxDepth}
              highlight={hl}
              onClick={() => onPriceClick(a.price)}
              onEnter={() => setHover({ side: "ask", idx: displayIdx })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

  const Bids = (
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
              maxCum={maxDepth}
              highlight={hl}
              onClick={() => onPriceClick(b.price)}
              onEnter={() => setHover({ side: "bid", idx: i })}
              onLeave={() => setHover(null)}
            />
          );
        })
      )}
    </div>
  );

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
              <div className="relative">
                <button
                  className="flex items-center gap-[6px] hover:text-[#e6e6e6] transition-colors"
                  onClick={() => setTickOpen((v) => !v)}
                >
                  {tick} <CaretIcon />
                </button>
                {tickOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setTickOpen(false)} />
                    <div className="absolute left-0 top-full mt-1 z-50 rounded-[8px] border border-[#1f232a] bg-[#12151a] p-1 shadow-[0_10px_30px_rgba(0,0,0,.5)]">
                      {TICKS.map((t, i) => (
                        <button
                          key={t}
                          onClick={() => { setTickIdx(i); setTickOpen(false); }}
                          className={`block w-full text-left px-3 py-[5px] rounded-[5px] transition-colors ${
                            i === tickIdx ? "text-[#f7931a]" : "text-[#8a8f97] hover:text-[#e6e6e6] hover:bg-[#1f232a]"
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
              {wsConnected && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[#54bd7c]"
                  style={{ boxShadow: "0 0 4px rgba(31,174,91,0.6)" }}
                  title="Live via WebSocket"
                />
              )}
            </div>
            <div className="flex items-center gap-[10px]">
              <button
                className="flex items-center gap-[5px] hover:text-[#e6e6e6] transition-colors"
                onClick={() => setDenomQuote((v) => !v)}
                title="Toggle size denomination"
              >
                {denomQuote ? <UsdcLogo size={13} /> : <XlmLogo size={13} />} {unit}{" "}
                <span className="text-[#3fb27f]"><SwapIcon /></span>
              </button>
              <button
                className="hover:opacity-80 transition-opacity"
                onClick={() => setViewMode((m) => (m === "both" ? "asks" : m === "asks" ? "bids" : "both"))}
                title={`View: ${viewMode}`}
              >
                <svg width={16} height={14} viewBox="0 0 16 14" fill="none">
                  <circle cx="2.4" cy="4" r="1.7" fill={viewMode === "bids" ? "#3a3f47" : "#e06a6a"} />
                  <rect x="6" y="3.2" width="9" height="1.6" rx="0.8" fill={viewMode === "bids" ? "#3a3f47" : "#6b7280"} />
                  <circle cx="2.4" cy="10" r="1.7" fill={viewMode === "asks" ? "#3a3f47" : "#54bd7c"} />
                  <rect x="6" y="9.2" width="9" height="1.6" rx="0.8" fill={viewMode === "asks" ? "#3a3f47" : "#6b7280"} />
                </svg>
              </button>
            </div>
          </div>

          {/* Column headers */}
          <div
            className="grid grid-cols-3 px-[14px] py-[7px] font-mono text-[11px] text-[#8a8f97] border-b border-[#1f232a] shrink-0"
            style={{ letterSpacing: ".02em" }}
          >
            <span>Price USDC</span>
            <span className="text-right">Size {unit}</span>
            <span className="text-right">Total {unit}</span>
          </div>

          {viewMode !== "bids" && Asks}

          {/* Spread row */}
          <div
            className="grid grid-cols-3 px-[14px] py-[9px] bg-[#16161a] font-mono text-[12px] shrink-0"
            style={{ borderBlock: "1px solid #1f232a" }}
          >
            <span className="font-medium text-[#e6e6e6]">{spreadAbs ?? "—"}</span>
            <span className="text-center text-[#8a8f97]">Spread</span>
            <span className="text-right text-[#8a8f97]">{spreadPct}</span>
          </div>

          {viewMode !== "asks" && Bids}
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
                  onClick={() => setSelectedPrice(marketId, parseFloat(t.price))}
                >
                  <span className={t.side === "buy" ? "text-[#54bd7c]" : "text-[#e06a6a]"}>
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

type HoverState = { side: "ask" | "bid"; idx: number } | null;

function fmt(n: number): string {
  return n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : n.toFixed(2);
}

function BookRow({
  level,
  side,
  maxCum,
  highlight,
  onClick,
  onEnter,
  onLeave,
}: {
  level: LevelRow;
  side: "ask" | "bid";
  maxCum: number;
  highlight: boolean;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const barPct = (level.cum / maxCum) * 100;

  return (
    <div
      className="relative grid grid-cols-3 font-mono text-[12px] cursor-pointer hover:bg-white/[0.03]"
      style={{ padding: "3.5px 14px", lineHeight: 1.45 }}
      onClick={onClick}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
    >
      <div
        className={`absolute top-0 bottom-0 right-0 ${
          side === "ask" ? "bg-[rgba(200,68,68,0.24)]" : "bg-[rgba(62,176,106,0.18)]"
        }`}
        style={{ width: `${barPct}%` }}
      />
      {highlight && <div className="absolute left-0 right-0 top-0 h-[1px] bg-[#f4f4f4] opacity-60 z-10" />}
      <span className={`relative z-10 ${side === "ask" ? "text-[#e06a6a]" : "text-[#54bd7c]"}`}>
        {level.price.toFixed(4)}
      </span>
      <span className="relative z-10 text-right text-[#e6e6e6]">{fmt(level.metric)}</span>
      <span className="relative z-10 text-right text-[#e6e6e6]">{fmt(level.cum)}</span>
    </div>
  );
}

function EmptyRows({ count, side }: { count: number; side: "ask" | "bid" }) {
  const widths = [40, 56, 32, 48, 36, 52, 28, 44, 60, 34, 50, 38, 46, 30];
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-3 font-mono text-[12px]"
          style={{ padding: "3.5px 14px", lineHeight: 1.45 }}
        >
          <div
            className={`h-[5px] rounded-full opacity-[0.06] ${side === "ask" ? "bg-[#e06a6a]" : "bg-[#54bd7c]"}`}
            style={{ width: widths[i % widths.length] }}
          />
          <div className="h-[5px] rounded-full bg-[#2a2f37] opacity-[0.06] ml-auto" style={{ width: 36 }} />
          <div className="h-[5px] rounded-full bg-[#2a2f37] opacity-[0.06] ml-auto" style={{ width: 44 }} />
        </div>
      ))}
    </>
  );
}
