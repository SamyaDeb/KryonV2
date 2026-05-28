#!/usr/bin/env tsx
/**
 * matcher-service.ts
 *
 * Off-chain CLOB matching engine. Polls the DB for resting limit orders,
 * runs price-time priority matching, writes Fill records, and updates
 * Order.filledSize. The trade feed, candlesticks, and orderbook all update
 * in real time once this is running.
 *
 * On-chain settlement (settle_fill on perp-order-gateway) requires signed
 * auth entries from both maker and taker — this service handles the
 * off-chain matching and DB state; settlement is submitted when both parties'
 * Freighter auth entries are collected (see settle-fill route, future work).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/matcher-service.ts
 *   or: npm run dev:matcher
 */

import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { submitSettleFillDirect } from "../lib/stellar/settlement";

type Sql = NeonQueryFunction<false, false>;

const POLL_INTERVAL_MS = 1_000;
const NETWORK = "testnet";
const PRICE_PRECISION = 1e18;
const AMOUNT_PRECISION = 1e7;
const MARKETS = [{ id: 1, symbol: "XLM-PERP" }];

// ── Types ────────────────────────────────────────────────────────────────────

interface RestingOrder {
  id: string;
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;        // raw 1e7
  limitPrice: bigint;  // raw 1e18; 0 = market order
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
  filledSize: bigint;
  createdAt: Date;
}

interface MatchResult {
  maker: RestingOrder;
  taker: RestingOrder;
  fillSize: bigint;
  fillPrice: bigint;
}

// ── Order loading ─────────────────────────────────────────────────────────────

function mapOrderRow(r: Record<string, unknown>): RestingOrder {
  return {
    id:         String(r.id),
    owner:      String(r.owner),
    marketId:   Number(r.marketId),
    isLong:     Boolean(r.isLong),
    size:       BigInt(r.size as string),
    limitPrice: BigInt(r.limitPrice as string),
    reduceOnly: Boolean(r.reduceOnly),
    nonce:      BigInt(r.nonce as string),
    expiryTs:   BigInt(r.expiryTs as string),
    filledSize: BigInt(r.filledSize as string),
    createdAt:  new Date(r.createdAt as string),
  };
}

async function loadRestingOrders(sql: Sql, marketId: number): Promise<RestingOrder[]> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows = await sql`
    SELECT
      id, owner, "marketId", "isLong",
      size::text, "limitPrice"::text, "reduceOnly",
      nonce::text, "expiryTs"::text, "filledSize"::text,
      "createdAt"
    FROM "Order"
    WHERE
      "marketId"   = ${marketId}
      AND cancelled = false
      AND "limitPrice" <> '0'
      AND "filledSize"::numeric < size::numeric
      AND ("expiryTs"::numeric = 0 OR "expiryTs"::numeric > ${nowSec.toString()})
    ORDER BY "limitPrice"::numeric ASC, "createdAt" ASC
  `;
  return rows.map(mapOrderRow);
}

async function loadMarketOrders(sql: Sql, marketId: number): Promise<RestingOrder[]> {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows = await sql`
    SELECT
      id, owner, "marketId", "isLong",
      size::text, "limitPrice"::text, "reduceOnly",
      nonce::text, "expiryTs"::text, "filledSize"::text,
      "createdAt"
    FROM "Order"
    WHERE
      "marketId"   = ${marketId}
      AND cancelled = false
      AND "limitPrice" = '0'
      AND "filledSize"::numeric < size::numeric
      AND ("expiryTs"::numeric = 0 OR "expiryTs"::numeric > ${nowSec.toString()})
    ORDER BY "createdAt" ASC
  `;
  return rows.map(mapOrderRow);
}

// ── Price-time priority matching ─────────────────────────────────────────────

/**
 * Single-pass matching engine supporting both limit and market orders.
 *
 * Pass 1 – market orders vs resting limit orders
 *   Market orders are always taker; fill price = resting limit order's price.
 *   Market buys  hit the cheapest available ask.
 *   Market sells hit the highest available bid.
 *
 * Pass 2 – limit vs limit (price-time priority, unchanged behaviour)
 *
 * A shared pendingFills map carries partial-fill accounting across both passes
 * so the same liquidity is never consumed twice.
 */
function matchAll(limitOrders: RestingOrder[], marketOrders: RestingOrder[]): MatchResult[] {
  const pendingFills = new Map<string, bigint>();
  const results: MatchResult[] = [];

  const remaining = (o: RestingOrder) =>
    o.size - o.filledSize - (pendingFills.get(o.id) ?? 0n);

  const add = (a: string, delta: bigint) =>
    pendingFills.set(a, (pendingFills.get(a) ?? 0n) + delta);

  // Pre-sort limit sides once
  const limitBids = limitOrders
    .filter((o) => o.isLong)
    .sort((a, b) => Number(b.limitPrice - a.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  const limitAsks = limitOrders
    .filter((o) => !o.isLong)
    .sort((a, b) => Number(a.limitPrice - b.limitPrice) || a.createdAt.getTime() - b.createdAt.getTime());

  // ── Pass 1: market orders vs limit resting book ──────────────────────────

  // Market SELLS → hit best bids (highest first)
  for (const mo of marketOrders.filter((o) => !o.isLong)) {
    for (const bid of limitBids) {
      if (bid.owner === mo.owner) continue;
      const bidRem = remaining(bid);
      const moRem  = remaining(mo);
      if (bidRem <= 0n || moRem <= 0n) continue;
      const fillSize = bidRem < moRem ? bidRem : moRem;
      add(bid.id, fillSize);
      add(mo.id,  fillSize);
      results.push({ maker: bid, taker: mo, fillSize, fillPrice: bid.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // Market BUYS → hit best asks (lowest first)
  for (const mo of marketOrders.filter((o) => o.isLong)) {
    for (const ask of limitAsks) {
      if (ask.owner === mo.owner) continue;
      const askRem = remaining(ask);
      const moRem  = remaining(mo);
      if (askRem <= 0n || moRem <= 0n) continue;
      const fillSize = askRem < moRem ? askRem : moRem;
      add(ask.id, fillSize);
      add(mo.id,  fillSize);
      results.push({ maker: ask, taker: mo, fillSize, fillPrice: ask.limitPrice });
      if (remaining(mo) <= 0n) break;
    }
  }

  // ── Pass 2: limit vs limit (price-time priority) ──────────────────────────

  for (const bid of limitBids) {
    for (const ask of limitAsks) {
      if (bid.owner === ask.owner) continue;
      if (bid.limitPrice < ask.limitPrice) break;
      const bidRem = remaining(bid);
      const askRem = remaining(ask);
      if (bidRem <= 0n || askRem <= 0n) continue;
      const fillSize   = bidRem < askRem ? bidRem : askRem;
      const makerFirst = bid.createdAt <= ask.createdAt;
      const maker      = makerFirst ? bid : ask;
      const taker      = makerFirst ? ask : bid;
      add(bid.id, fillSize);
      add(ask.id, fillSize);
      results.push({ maker, taker, fillSize, fillPrice: maker.limitPrice });
      if (remaining(bid) <= 0n) break;
    }
  }

  return results;
}

// ── Persist a fill ────────────────────────────────────────────────────────────

function pseudoTxHash(maker: RestingOrder, taker: RestingOrder, fillSize: bigint): string {
  // Deterministic fake hash for off-chain fills — prefixed so they're identifiable
  const raw = `db:${maker.owner}:${maker.nonce}:${taker.owner}:${taker.nonce}:${fillSize}`;
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = Math.imul(31, h) + raw.charCodeAt(i) | 0;
  }
  return "dbfill" + Math.abs(h).toString(16).padStart(58, "0");
}

async function persistFill(sql: Sql, match: MatchResult): Promise<boolean> {
  const { maker, taker, fillSize, fillPrice } = match;
  const txHash = pseudoTxHash(maker, taker, fillSize);

  try {
    const inserted = await sql`
      INSERT INTO "Fill" (
        network, "marketId",
        maker, "makerNonce",
        taker, "takerNonce",
        "fillSize", "fillPrice",
        "feeMaker", "feeTaker",
        "txHash", ledger,
        "createdAt"
      ) VALUES (
        ${NETWORK},
        ${maker.marketId},
        ${maker.owner}, ${maker.nonce.toString()},
        ${taker.owner}, ${taker.nonce.toString()},
        ${fillSize.toString()}, ${fillPrice.toString()},
        '0', '0',
        ${txHash}, 0,
        NOW()
      )
      ON CONFLICT (network, "txHash", maker, "makerNonce", taker, "takerNonce") DO NOTHING
      RETURNING id
    `;

    // If DO NOTHING fired (duplicate fill), skip the filledSize updates
    if (!inserted || inserted.length === 0) return false;

    // Update filledSize on both orders
    await sql`
      UPDATE "Order"
      SET "filledSize" = ("filledSize"::numeric + ${fillSize.toString()}::numeric)::text,
          "updatedAt"  = NOW()
      WHERE id = ${maker.id}
    `;
    await sql`
      UPDATE "Order"
      SET "filledSize" = ("filledSize"::numeric + ${fillSize.toString()}::numeric)::text,
          "updatedAt"  = NOW()
      WHERE id = ${taker.id}
    `;

    // Update Market.lastPrice and volume
    const fillValue = (fillSize * fillPrice) / BigInt(Math.round(PRICE_PRECISION));
    await sql`
      UPDATE "Market"
      SET
        "lastPrice" = ${fillPrice.toString()},
        volume      = (volume::numeric + ${fillValue.toString()}::numeric)::text,
        "updatedAt" = NOW()
      WHERE id = ${maker.marketId}
    `;

    return true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Duplicate fill is fine — another instance may have processed it
    if (msg.includes("unique") || msg.includes("duplicate")) return false;
    process.stderr.write(`  ✗ persist fill: ${msg.slice(0, 100)}\n`);
    return false;
  }
}

// ── Submit on-chain settlement after a fill ───────────────────────────────────
// settle_fill uses SOROBAN_CREDENTIALS_SOURCE_ACCOUNT — only the fee-payer's
// transaction signature is required. No individual Freighter auth entries needed.

async function executeSettlement(match: MatchResult): Promise<void> {
  const feePayerSecret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!feePayerSecret) return;

  const result = await submitSettleFillDirect({
    maker: {
      owner:      match.maker.owner,
      marketId:   match.maker.marketId,
      isLong:     match.maker.isLong,
      size:       match.maker.size,
      limitPrice: match.maker.limitPrice,
      reduceOnly: match.maker.reduceOnly,
      nonce:      match.maker.nonce,
      expiryTs:   match.maker.expiryTs,
    },
    taker: {
      owner:      match.taker.owner,
      marketId:   match.taker.marketId,
      isLong:     match.taker.isLong,
      size:       match.taker.size,
      limitPrice: match.taker.limitPrice,
      reduceOnly: match.taker.reduceOnly,
      nonce:      match.taker.nonce,
      expiryTs:   match.taker.expiryTs,
    },
    fillSize:      match.fillSize,
    fillPrice:     match.fillPrice,
    feePayerSecret,
  });

  if ("error" in result) {
    process.stderr.write(`  ✗ settlement failed: ${result.error.slice(0, 100)}\n`);
  } else {
    process.stdout.write(`  ✓ settled on-chain: ${result.hash}\n`);
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

function fmtPrice(raw: bigint) {
  return (Number(raw) / PRICE_PRECISION).toFixed(4);
}

function fmtSize(raw: bigint) {
  return (Number(raw) / AMOUNT_PRECISION).toFixed(4);
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function tick(sql: Sql) {
  let totalFills = 0;

  for (const market of MARKETS) {
    const [limitOrders, marketOrders] = await Promise.all([
      loadRestingOrders(sql, market.id),
      loadMarketOrders(sql, market.id),
    ]);
    if (limitOrders.length === 0 && marketOrders.length === 0) continue;

    const matches = matchAll(limitOrders, marketOrders);
    for (const match of matches) {
      const fillHash = pseudoTxHash(match.maker, match.taker, match.fillSize);
      const ok = await persistFill(sql, match);
      if (ok) {
        totalFills++;
        const time = new Date().toISOString().slice(11, 19);
        const orderType = match.taker.limitPrice === 0n ? "MKT" : "LMT";
        process.stdout.write(
          `[${time}] ${market.symbol} ${orderType} fill: ${fmtSize(match.fillSize)} @ $${fmtPrice(match.fillPrice)}` +
          `  maker=${match.maker.owner.slice(0, 8)} taker=${match.taker.owner.slice(0, 8)}\n`
        );
        // Submit on-chain settlement immediately — fee-payer signs, no user auth needed
        executeSettlement(match).catch((e: unknown) => {
          process.stderr.write(`  ✗ executeSettlement: ${(e as Error).message?.slice(0, 80)}\n`);
        });
      }
    }
  }

  return totalFills;
}

async function run() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("❌  DATABASE_URL is not set in your .env.local");
    process.exit(1);
  }

  const sql = neon(dbUrl);
  console.log("✓ Matcher service starting");
  console.log(`  Markets  : ${MARKETS.map((m) => m.symbol).join(", ")}`);
  console.log(`  Interval : ${POLL_INTERVAL_MS}ms`);
  console.log(`  Fill type: off-chain DB fills (on-chain settlement requires dual Freighter auth)`);
  console.log("");

  // Print orderbook summary on first tick
  for (const market of MARKETS) {
    const [limitOrders, marketOrders] = await Promise.all([
      loadRestingOrders(sql, market.id),
      loadMarketOrders(sql, market.id),
    ]);
    const bids = limitOrders.filter((o) => o.isLong);
    const asks = limitOrders.filter((o) => !o.isLong);
    console.log(`  ${market.symbol}: ${bids.length} bids, ${asks.length} asks resting, ${marketOrders.length} market orders pending`);
  }
  console.log("");

  // Sequential loop — never overlap ticks, avoids fill race conditions
  while (true) {
    try {
      await tick(sql);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`  ✗ tick: ${msg.slice(0, 100)}\n`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

run().catch(console.error);
