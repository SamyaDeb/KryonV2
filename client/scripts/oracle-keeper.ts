#!/usr/bin/env tsx
/**
 * Oracle Keeper — publishes active-market prices to the perp-oracle-adapter.
 *
 * Price integrity model:
 *   - Every price is the MEDIAN of up to three independent sources
 *     (Binance, Coinbase, Kraken). At least ORACLE_MIN_SOURCES (default 2)
 *     must respond or the tick is skipped.
 *   - If the surviving sources disagree by more than
 *     ORACLE_MAX_SOURCE_DEVIATION_BPS (default 200 = 2%), the tick is skipped:
 *     a stale-but-honest price (engine halts on staleness) beats a wrong one.
 *   - USDC is SOURCED, not assumed at $1. If the sourced price departs the peg
 *     by more than USDC_DEPEG_HALT_BPS (default 100 = 1%), USDC publication
 *     halts — collateral valuation goes stale and settlement fail-stops rather
 *     than valuing depegged collateral at par. On testnet only, a $1 fallback
 *     is used when the stablecoin sources are unreachable.
 *
 * Requires:
 *   ORACLE_PUBLISHER_SECRET=S... (Stellar secret key of the authorized publisher)
 *
 * Usage:
 *   ORACLE_PUBLISHER_SECRET=S... npx tsx scripts/oracle-keeper.ts
 *   or via package.json: npm run dev:oracle
 */

import {
  Keypair,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import { ACTIVE_MARKETS, CONTRACTS, NETWORK } from "../config";
import { assertRequiredSecrets, assertNoPublicSecretLeak } from "../lib/secrets-check";
assertRequiredSecrets(["DATABASE_URL", "ORACLE_PUBLISHER_SECRET"]);
assertNoPublicSecretLeak();

const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
// Fetch every 8s (fast deviation detection) but PUBLISH only on deviation or
// heartbeat — on mainnet every publish costs real fees (~0.0004 XLM), and
// blind 8s publishing burns ~8.5 XLM/day. Heartbeats MUST stay under the
// on-chain OracleGuard max_age_secs (120s) or settlement fail-stops between
// publishes.
const FETCH_INTERVAL_MS = 8_000;
const PUBLISH_DEVIATION_BPS = Number(process.env.PUBLISH_DEVIATION_BPS ?? "30");
const PUBLISH_HEARTBEAT_SECS = Number(process.env.PUBLISH_HEARTBEAT_SECS ?? "60");
const USDC_PUBLISH_DEVIATION_BPS = Number(process.env.USDC_PUBLISH_DEVIATION_BPS ?? "10");
const USDC_PUBLISH_HEARTBEAT_SECS = Number(process.env.USDC_PUBLISH_HEARTBEAT_SECS ?? "90");
const MIN_SOURCES = Number(process.env.ORACLE_MIN_SOURCES ?? "2");
const MAX_SOURCE_DEVIATION_BPS = Number(process.env.ORACLE_MAX_SOURCE_DEVIATION_BPS ?? "200");
const USDC_DEPEG_HALT_BPS = Number(process.env.USDC_DEPEG_HALT_BPS ?? "100");
const ORACLE_MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({
  symbol: m.symbol,
  oracleSymbol: m.oracleSymbol,
  baseAsset: m.baseAsset,
  priceSourceSymbol: m.priceSourceSymbol,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function toI128ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function toU64ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

// ── Independent price sources ────────────────────────────────────────────────
// Each returns a float USD price or throws. A 5s timeout keeps one slow venue
// from stalling the whole tick.

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  } as RequestInit);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function binancePrice(binanceSymbol: string): Promise<number> {
  const data = (await fetchJson(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(binanceSymbol)}`
  )) as { price: string };
  const p = parseFloat(data.price);
  if (!Number.isFinite(p) || p <= 0) throw new Error("binance: bad price");
  return p;
}

async function coinbasePrice(baseAsset: string): Promise<number> {
  const data = (await fetchJson(
    `https://api.coinbase.com/v2/prices/${encodeURIComponent(baseAsset)}-USD/spot`
  )) as { data?: { amount?: string } };
  const p = parseFloat(data.data?.amount ?? "");
  if (!Number.isFinite(p) || p <= 0) throw new Error("coinbase: bad price");
  return p;
}

async function krakenPrice(baseAsset: string): Promise<number> {
  // Kraken uses XBT for BTC.
  const pair = `${baseAsset === "BTC" ? "XBT" : baseAsset}USD`;
  const data = (await fetchJson(
    `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`
  )) as { error?: string[]; result?: Record<string, { c?: [string, string] }> };
  if (data.error?.length) throw new Error(`kraken: ${data.error[0]}`);
  const first = Object.values(data.result ?? {})[0];
  const p = parseFloat(first?.c?.[0] ?? "");
  if (!Number.isFinite(p) || p <= 0) throw new Error("kraken: bad price");
  return p;
}

interface AggregatedPrice {
  price: bigint;
  confidence: bigint;
  publishTime: bigint;
  sources: number;
}

/**
 * Median across the sources that responded. Returns null (skip the tick) when
 * fewer than MIN_SOURCES respond or the responders disagree beyond
 * MAX_SOURCE_DEVIATION_BPS — publishing nothing lets the on-chain staleness
 * guard fail-stop the protocol instead of feeding it a manipulable price.
 */
async function aggregatePrice(
  label: string,
  fetchers: Array<() => Promise<number>>
): Promise<AggregatedPrice | null> {
  const settled = await Promise.allSettled(fetchers.map((f) => f()));
  const prices = settled
    .filter((s): s is PromiseFulfilledResult<number> => s.status === "fulfilled")
    .map((s) => s.value)
    .sort((a, b) => a - b);

  if (prices.length < MIN_SOURCES) {
    const errors = settled
      .filter((s): s is PromiseRejectedResult => s.status === "rejected")
      .map((s) => String(s.reason).slice(0, 60));
    console.error(`\n  ✗ ${label}: only ${prices.length}/${fetchers.length} sources (need ${MIN_SOURCES}): ${errors.join(" | ")}`);
    return null;
  }

  const spreadBps = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 10_000;
  if (spreadBps > MAX_SOURCE_DEVIATION_BPS) {
    console.error(`\n  ✗ ${label}: source deviation ${spreadBps.toFixed(0)}bps > ${MAX_SOURCE_DEVIATION_BPS}bps — skipping publish (fail-safe)`);
    return null;
  }

  const mid = prices.length % 2 === 1
    ? prices[(prices.length - 1) / 2]
    : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2;
  const price = BigInt(Math.round(mid * Number(PRICE_PRECISION)));
  // Confidence: at least 0.1%, widened to half the observed source spread.
  const spreadConfidence = BigInt(Math.round(((prices[prices.length - 1] - prices[0]) / 2) * Number(PRICE_PRECISION)));
  const confidence = spreadConfidence > price / 1000n ? spreadConfidence : price / 1000n;
  return {
    price,
    confidence,
    publishTime: BigInt(Math.floor(Date.now() / 1000)),
    sources: prices.length,
  };
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) {
    console.error("❌  ORACLE_PUBLISHER_SECRET is not set.");
    console.error("    Add ORACLE_PUBLISHER_SECRET=S... to your .env.local");
    process.exit(1);
  }

  const publisherKp = Keypair.fromSecret(secret);
  const publisherAddress = publisherKp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const contract = new Contract(CONTRACTS.oracleAdapter);
  const publisherArg = nativeToScVal(publisherAddress, { type: "address" });

  console.log(`✓ Oracle keeper starting`);
  console.log(`  Publisher : ${publisherAddress}`);
  console.log(`  Network   : ${NETWORK.name}`);
  console.log(`  Contract  : ${CONTRACTS.oracleAdapter}`);
  console.log(`  Markets   : ${ORACLE_MARKETS.map((m) => `${m.symbol}:${m.priceSourceSymbol}`).join(", ")}`);
  console.log(`  Fetch     : ${FETCH_INTERVAL_MS / 1000}s; publish on ${PUBLISH_DEVIATION_BPS}bps move or ${PUBLISH_HEARTBEAT_SECS}s heartbeat (USDC: ${USDC_PUBLISH_DEVIATION_BPS}bps/${USDC_PUBLISH_HEARTBEAT_SECS}s)`);

  // Last successfully published price/time per asset, for deviation+heartbeat
  // gating. Only updated on confirmed success so failures retry next fetch.
  const lastPublished = new Map<string, { price: bigint; ts: number }>();

  function shouldPublish(asset: string, price: bigint, deviationBps: number, heartbeatSecs: number): boolean {
    const last = lastPublished.get(asset);
    if (!last) return true;
    if (Date.now() - last.ts >= heartbeatSecs * 1000) return true;
    const diff = price > last.price ? price - last.price : last.price - price;
    return Number((diff * 10_000n) / last.price) >= deviationBps;
  }

  async function writePrice(oracleSymbol: string, price: bigint, confidence: bigint, publishTime: bigint): Promise<boolean> {
    // Fetch real sequence for submission
    const onChainAccount = await server.getAccount(publisherAddress);
    const assetArg = nativeToScVal(oracleSymbol, { type: "symbol" });

    const tx = new TransactionBuilder(onChainAccount, { fee: "500000", networkPassphrase: NETWORK.passphrase })
      .addOperation(
        contract.call(
          "write_price",
          assetArg,
          publisherArg,
          toI128ScVal(price),
          toI128ScVal(confidence),
          toU64ScVal(publishTime)
        )
      )
      .setTimeout(30)
      .build();

    // Simulate to get footprint + auth
    const simResult = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(simResult)) {
      process.stdout.write(` ✗ sim: ${simResult.error?.slice(0, 80)}\n`);
      return false;
    }

    const prepared = sorobanRpc.assembleTransaction(tx, simResult).build();
    prepared.sign(publisherKp);

    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      process.stdout.write(` ✗ submit: ${send.errorResult?.toXDR("base64")?.slice(0, 60)}\n`);
      return false;
    }

    // Poll for confirmation
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        process.stdout.write(` ✓ ${send.hash.slice(0, 12)}\n`);
        return true;
      }
      if (poll.status === "FAILED") {
        process.stdout.write(` ✗ tx failed\n`);
        return false;
      }
    }
    process.stdout.write(` ? timeout\n`);
    return false; // ambiguous — retry next fetch; a duplicate publish is harmless
  }

  async function publishMarket(market: (typeof ORACLE_MARKETS)[number]) {
    try {
      const agg = await aggregatePrice(market.oracleSymbol, [
        () => binancePrice(market.priceSourceSymbol),
        () => coinbasePrice(market.baseAsset),
        () => krakenPrice(market.baseAsset),
      ]);
      if (!agg) return; // fail-safe: skip tick, on-chain staleness guard takes over
      if (!shouldPublish(market.oracleSymbol, agg.price, PUBLISH_DEVIATION_BPS, PUBLISH_HEARTBEAT_SECS)) return;
      const priceHuman = Number(agg.price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing ${market.oracleSymbol} $${priceHuman.toFixed(4)} (${agg.sources} sources) at ${new Date().toISOString().slice(11, 19)}...`);
      if (await writePrice(market.oracleSymbol, agg.price, agg.confidence, agg.publishTime)) {
        lastPublished.set(market.oracleSymbol, { price: agg.price, ts: Date.now() });
      }
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  // The settlement/collateral asset (USDC) needs a fresh on-chain price so the
  // vault can value collateral during account_health. The price is SOURCED —
  // on a depeg beyond USDC_DEPEG_HALT_BPS we stop publishing, so collateral
  // valuation goes stale and the protocol fail-stops instead of valuing
  // depegged USDC at par (deposit-and-drain vector).
  async function publishUsdc() {
    try {
      const agg = await aggregatePrice("USDC", [
        () => coinbasePrice("USDC"),
        () => krakenPrice("USDC"),
      ]);

      let price: bigint;
      let confidence: bigint;
      if (agg) {
        const deviationBps = Number(
          ((agg.price > PRICE_PRECISION ? agg.price - PRICE_PRECISION : PRICE_PRECISION - agg.price) * 10_000n) /
            PRICE_PRECISION
        );
        if (deviationBps > USDC_DEPEG_HALT_BPS) {
          console.error(`\n  ✗✗ USDC DEPEG: sourced $${(Number(agg.price) / 1e18).toFixed(4)} is ${deviationBps}bps off peg — HALTING USDC publication (settlement will fail-stop on staleness)`);
          return;
        }
        price = agg.price;
        confidence = agg.confidence;
      } else if (NETWORK.name !== "mainnet") {
        // Testnet-only convenience: stablecoin sources unreachable — publish
        // the peg so local development is not blocked. NEVER on mainnet.
        price = PRICE_PRECISION;
        confidence = PRICE_PRECISION / 1000n;
      } else {
        console.error("\n  ✗ USDC: sources unavailable on mainnet — skipping publish (fail-safe)");
        return;
      }

      if (!shouldPublish("USDC", price, USDC_PUBLISH_DEVIATION_BPS, USDC_PUBLISH_HEARTBEAT_SECS)) return;
      const priceHuman = Number(price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing USDC $${priceHuman.toFixed(4)} at ${new Date().toISOString().slice(11, 19)}...`);
      if (await writePrice("USDC", price, confidence, BigInt(Math.floor(Date.now() / 1000)))) {
        lastPublished.set("USDC", { price, ts: Date.now() });
      }
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  // Confirmation polling can outlast the fetch interval; overlapping ticks
  // race the publisher's sequence number and double-publish at heartbeats.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await tickInner();
    } finally {
      ticking = false;
    }
  }

  async function tickInner() {
    for (const market of ORACLE_MARKETS) {
      await publishMarket(market);
    }
    await publishUsdc();
  }

  // Run immediately then on interval
  await tick();
  setInterval(tick, FETCH_INTERVAL_MS);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch(console.error);
