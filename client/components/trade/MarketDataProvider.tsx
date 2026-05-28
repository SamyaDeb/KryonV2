"use client";

import { useEffect, useRef } from "react";
import { useMarketStore } from "@/store/market";
import { getOraclePrice } from "@/lib/stellar/oracle";
import { fetchOrderBook, fetchRecentTrades } from "@/lib/orders/matcher";
import {
  wsSetHandlers,
  wsSubscribe,
  wsUnsubscribe,
  wsDisconnect,
  wsReset,
} from "@/lib/ws/client";
import { INDEXER_URL, MATCHER_URL, MARKETS, PRICE_PRECISION } from "@/lib/config";
import type { OrderBook, RecentTrade } from "@/lib/orders/matcher";

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

async function fetchBinanceLivePrice(marketId: number): Promise<bigint | null> {
  try {
    const pair = getBinancePair(marketId);
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
      { cache: "no-store" }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { price: string };
    const priceFloat = parseFloat(data.price);
    if (isNaN(priceFloat) || priceFloat <= 0) return null;
    return BigInt(Math.round(priceFloat * Number(PRICE_PRECISION)));
  } catch {
    return null;
  }
}

export function MarketDataProvider({ marketId, children }: Props) {
  const store = useMarketStore();
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const oraclePollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statsPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsActiveRef = useRef(false);

  // ── Oracle price → Binance fallback ────────────────────────────────────────
  async function pollOracle() {
    const result = await getOraclePrice();
    if (result && result.price > 0n) {
      store.setMarkPrice(marketId, result.price);
      return;
    }
    // Oracle keeper not running — fall back to Binance live price
    const binancePrice = await fetchBinanceLivePrice(marketId);
    if (binancePrice) store.setMarkPrice(marketId, binancePrice);
  }

  // ── Orderbook / trades REST polling (fallback when WS is down) ──────────────
  async function pollOrderBook() {
    if (wsActiveRef.current) return;
    const book = await fetchOrderBook(marketId);
    if (book) store.setOrderBook(marketId, book);
  }

  async function pollTrades() {
    if (wsActiveRef.current) return;
    const trades = await fetchRecentTrades(marketId);
    if (trades.length > 0) store.setTrades(marketId, trades);
  }

  // ── Market stats from indexer / node-runtime ────────────────────────────────
  async function pollMarketStats() {
    const base = INDEXER_URL || MATCHER_URL || "";
    if (!base) return;
    try {
      const res = await fetch(`${base}/markets/${marketId}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Record<string, unknown>;
      store.setMarketStats(marketId, {
        lastPrice: BigInt(String(data["last_price"] ?? "0")),
        volume: BigInt(String(data["volume"] ?? "0")),
        longOI: BigInt(String(data["long_open_interest"] ?? "0")),
        shortOI: BigInt(String(data["short_open_interest"] ?? "0")),
      });
    } catch { /* best-effort */ }
  }

  // ── WS handlers ────────────────────────────────────────────────────────────
  function handleWsOrderBook(mid: number, book: OrderBook) {
    if (mid !== marketId) return;
    store.setOrderBook(mid, book);
  }

  function handleWsTrade(mid: number, trade: RecentTrade) {
    if (mid !== marketId) return;
    store.prependTrade(mid, trade);
  }

  function handleWsStatus(connected: boolean) {
    wsActiveRef.current = connected;
    store.setWsConnected(connected);
    if (!connected) {
      pollOrderBook();
      pollTrades();
    }
  }

  useEffect(() => {
    // Initial fetches immediately
    pollOracle();
    pollOrderBook();
    pollTrades();
    pollMarketStats();

    // Oracle price: every 3s (oracle keeper publishes every 10s; Binance is always fast)
    oraclePollRef.current = setInterval(pollOracle, 3_000);

    // REST polling: 1.5s, skipped when WS is active
    pollIntervalRef.current = setInterval(() => {
      pollOrderBook();
      pollTrades();
    }, 1_500);

    // Market stats: every 15s
    statsPollRef.current = setInterval(pollMarketStats, 15_000);

    // WebSocket
    wsReset();
    wsSetHandlers(handleWsOrderBook, handleWsTrade, handleWsStatus);
    wsSubscribe(marketId);

    return () => {
      if (oraclePollRef.current) clearInterval(oraclePollRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      if (statsPollRef.current) clearInterval(statsPollRef.current);
      wsUnsubscribe(marketId);
      wsDisconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketId]);

  return <>{children}</>;
}
