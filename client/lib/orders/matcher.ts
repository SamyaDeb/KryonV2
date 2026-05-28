"use client";

import { MATCHER_URL } from "../config";
import { OrderIntent, orderIntentToJson } from "./intent";

export interface MatcherOrder {
  intent: OrderIntent;
  status: "pending" | "filled" | "cancelled" | "expired";
  submittedAt: number;
}

export async function submitOrder(intent: OrderIntent): Promise<{ ok: boolean; error?: string }> {
  if (!MATCHER_URL) {
    return { ok: false, error: "Matcher not configured (NEXT_PUBLIC_MATCHER_URL not set). Order signed locally only." };
  }
  try {
    const res = await fetch(`${MATCHER_URL}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderIntentToJson(intent)),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, error: text };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cancelOrderOnMatcher(owner: string, nonce: bigint): Promise<void> {
  if (!MATCHER_URL) return;
  try {
    await fetch(`${MATCHER_URL}/orders/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner, nonce: nonce.toString() }),
    });
  } catch {
    // best-effort
  }
}

export async function fetchOrderBook(marketId: number): Promise<OrderBook | null> {
  if (!MATCHER_URL) return null;
  try {
    const res = await fetch(`${MATCHER_URL}/markets/${marketId}/orderbook`);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function fetchRecentTrades(marketId: number): Promise<RecentTrade[]> {
  if (!MATCHER_URL) return [];
  try {
    const res = await fetch(`${MATCHER_URL}/markets/${marketId}/trades?limit=50`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface RecentTrade {
  price: string;
  size: string;
  side: "buy" | "sell";
  timestamp: number;
}
