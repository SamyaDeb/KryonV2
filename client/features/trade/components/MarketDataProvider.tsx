"use client";

import { useEffect, useRef } from "react";
import { useMarketStore } from "@/stores/market";
import { getOraclePrice } from "@/lib/stellar/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/market/matcher";
import {
  wsSetHandlers,
  wsSubscribe,
  wsUnsubscribe,
  wsDisconnect,
  wsReset,
} from "@/lib/market/websocket";
import { MARKETS, PRICE_PRECISION } from "@/config";
import type { OrderBook, RecentTrade } from "@/lib/market/matcher";

interface Props {
  marketId: number;
  children: React.ReactNode;
}

// Derive Binance pair from market config base asset
function getBinancePair(marketId: number): string {
  const market = Object.values(MARKETS).find((m) => m.marketId === marketId);
  const base = market?.baseAsset ?? "XLM";
  return `${base}USDT`;
}

// Fetch Binance 24h ticker once — gives both last price and 24h % change.
async function fetchBinance24h(
  marketId: number
): Promise<{ price: bigint; changePct: number } | null> {
  try {
    const pair = getBinancePair(marketId);
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { lastPrice: string; priceChangePercent: string };
    const priceFloat = parseFloat(data.lastPrice);
    const changePct = parseFloat(data.priceChangePercent);
    return {
      price: priceFloat > 0 ? BigInt(Math.round(priceFloat * Number(PRICE_PRECISION))) : 0n,
      changePct: isNaN(changePct) ? 0 : changePct,
    };
  } catch {
    return null;
  }
}

export function MarketDataProvider({ marketId, children }: Props) {
  // NOTE: intentionally does NOT subscribe to the store (no useMarketStore()).
  // It only writes via getState() setters, so market-data ticks never re-render
  // this wrapper or its (stable) children.
  const wsActiveRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const set = () => useMarketStore.getState();

    // ── Oracle price → Binance fallback ──────────────────────────────────────
    async function pollOracle() {
      const result = await getOraclePrice();
      if (cancelled) return;
      if (result && result.price > 0n) {
        set().setMarkPrice(marketId, result.price);
        return;
      }
      // Oracle keeper not running — fall back to Binance live price
      const b = await fetchBinance24h(marketId);
      if (!cancelled && b && b.price > 0n) set().setMarkPrice(marketId, b.price);
    }

    // ── 24h change (Binance) ─────────────────────────────────────────────────
    async function poll24h() {
      const b = await fetchBinance24h(marketId);
      if (!cancelled && b) set().setPriceChangePct(marketId, b.changePct);
    }

    // ── Orderbook / trades REST polling (fallback when WS is down) ────────────
    async function pollOrderBook() {
      if (wsActiveRef.current) return;
      const book = await fetchOrderBook(marketId);
      if (!cancelled && book) set().setOrderBook(marketId, book);
    }

    async function pollTrades() {
      if (wsActiveRef.current) return;
      const trades = await fetchRecentTrades(marketId);
      if (!cancelled && trades.length > 0) set().setTrades(marketId, trades);
    }

    // ── Market stats from indexer / node-runtime ──────────────────────────────
    async function pollMarketStats() {
      try {
        const res = await fetch(`/api/markets/${marketId}`, { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        set().setMarketStats(marketId, {
          lastPrice: BigInt(String(data["last_price"] ?? "0")),
          volume: BigInt(String(data["volume"] ?? "0")),
          longOI: BigInt(String(data["long_open_interest"] ?? "0")),
          shortOI: BigInt(String(data["short_open_interest"] ?? "0")),
        });
      } catch { /* best-effort */ }
    }

    // ── WS handlers ──────────────────────────────────────────────────────────
    function handleWsOrderBook(mid: number, book: OrderBook) {
      if (mid !== marketId) return;
      set().setOrderBook(mid, book);
    }
    function handleWsTrade(mid: number, trade: RecentTrade) {
      if (mid !== marketId) return;
      set().prependTrade(mid, trade);
    }
    function handleWsStatus(connected: boolean) {
      wsActiveRef.current = connected;
      set().setWsConnected(connected);
      if (!connected) {
        pollOrderBook();
        pollTrades();
      }
    }

    // Initial fetches immediately
    pollOracle();
    poll24h();
    pollOrderBook();
    pollTrades();
    pollMarketStats();

    const timers = [
      setInterval(pollOracle, 3_000),
      setInterval(() => { pollOrderBook(); pollTrades(); }, 1_500),
      setInterval(pollMarketStats, 15_000),
      setInterval(poll24h, 30_000),
    ];

    wsReset();
    wsSetHandlers(handleWsOrderBook, handleWsTrade, handleWsStatus);
    wsSubscribe(marketId);

    return () => {
      cancelled = true;
      timers.forEach(clearInterval);
      wsUnsubscribe(marketId);
      wsDisconnect();
    };
  }, [marketId]);

  return <>{children}</>;
}
