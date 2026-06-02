#!/usr/bin/env tsx
/**
 * Monitor — checks liveness of all Kryon testnet services every 30s.
 *
 * Checks:
 *   - Oracle freshness (last on-chain price age)
 *   - Matcher lag (oldest pending order age)
 *   - Indexer lag (last Market row update)
 *   - DB latency (round-trip time)
 *   - App /api/health endpoint
 *   - WebSocket connectivity
 *
 * Usage:
 *   npm run dev:monitor
 */

import { neon } from "@neondatabase/serverless";
import { WebSocket } from "ws";
import { Contract, TransactionBuilder, Keypair, Account, rpc as sorobanRpc, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, ACTIVE_MARKETS } from "../config";

const CHECK_INTERVAL_MS = 30_000;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

const ORACLE_MAX_AGE_SECS = 60;
const MATCHER_LAG_WARN_SECS = 30;
const INDEXER_LAG_WARN_SECS = 60;
const DB_LATENCY_WARN_MS = 2_000;

const PRICE_PRECISION = 1e18;

// Synthetic sim account for read-only oracle queries
const _simKp = Keypair.random();
let _simSeq = 0;
function getSimAccount() {
  return new Account(_simKp.publicKey(), (_simSeq++).toString());
}

function db() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return neon(url);
}

type CheckResult = { name: string; ok: boolean; detail: string; ms: number };

async function timed(name: string, fn: () => Promise<string>): Promise<CheckResult> {
  const start = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, detail, ms: Date.now() - start };
  } catch (e) {
    return { name, ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : String(e), ms: Date.now() - start };
  }
}

// ── Checks ────────────────────────────────────────────────────────────────────

async function checkDbLatency(): Promise<string> {
  const sql = db();
  const t0 = Date.now();
  await sql`SELECT 1`;
  const ms = Date.now() - t0;
  if (ms > DB_LATENCY_WARN_MS) throw new Error(`DB latency ${ms}ms exceeds ${DB_LATENCY_WARN_MS}ms`);
  return `${ms}ms`;
}

async function checkOracleFreshness(): Promise<string> {
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const markets = Object.values(ACTIVE_MARKETS);
  const results: string[] = [];

  for (const market of markets) {
    const contract = new Contract(CONTRACTS.oracleAdapter);
    const account = getSimAccount();
    const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call(
        "get_price",
        nativeToScVal(market.oracleSymbol, { type: "symbol" }),
        xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")])
      ))
      .setTimeout(10)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`oracle sim failed: ${sim.error?.slice(0, 80)}`);

    const result = sim.result?.retval;
    if (!result) throw new Error("oracle returned no value");

    const snap = result.value() as xdr.ScMap;
    let publishTime = 0n;
    for (const entry of snap.entries()) {
      const key = entry.key().value()?.toString();
      if (key === "publish_time") publishTime = BigInt(entry.val().value() as bigint);
    }

    const ageS = Math.round((Date.now() / 1000) - Number(publishTime));
    if (ageS > ORACLE_MAX_AGE_SECS) throw new Error(`oracle ${market.oracleSymbol} is ${ageS}s stale (max ${ORACLE_MAX_AGE_SECS}s)`);
    results.push(`${market.oracleSymbol}=${ageS}s old`);
  }
  return results.join(", ");
}

async function checkMatcherLag(): Promise<string> {
  const sql = db();
  const rows = await sql`
    SELECT "createdAt" FROM "Order"
    WHERE cancelled = false AND "filledSize"::numeric < "size"::numeric
      AND "limitPrice" <> '0'
    ORDER BY "createdAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no resting orders";
  const ageS = Math.round((Date.now() - new Date(rows[0].createdAt).getTime()) / 1000);
  if (ageS > MATCHER_LAG_WARN_SECS) throw new Error(`oldest pending order is ${ageS}s old`);
  return `oldest order ${ageS}s`;
}

async function checkIndexerLag(): Promise<string> {
  const sql = db();
  const rows = await sql`
    SELECT "updatedAt" FROM "Market" ORDER BY "updatedAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no markets in DB";
  const ageS = Math.round((Date.now() - new Date(rows[0].updatedAt).getTime()) / 1000);
  if (ageS > INDEXER_LAG_WARN_SECS) throw new Error(`indexer last synced ${ageS}s ago`);
  return `last sync ${ageS}s ago`;
}

async function checkAppHealth(): Promise<string> {
  const res = await fetch(`${APP_URL}/api/health`, { cache: "no-store" } as RequestInit);
  if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
  return `HTTP ${res.status}`;
}

async function checkWebSocket(): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => { ws.close(); reject(new Error("WS open timeout")); }, 5_000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "ping" }));
    });
    ws.on("message", (d) => {
      const msg = JSON.parse(d.toString());
      if (msg.type === "pong") {
        clearTimeout(timer);
        ws.close();
        resolve("connected + pong");
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── Main loop ─────────────────────────────────────────────────────────────────

function color(ok: boolean) { return ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"; }

async function runChecks() {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`\n[${ts}] Running checks...`);

  const results = await Promise.all([
    timed("db-latency",       checkDbLatency),
    timed("oracle-freshness", checkOracleFreshness),
    timed("matcher-lag",      checkMatcherLag),
    timed("indexer-lag",      checkIndexerLag),
    timed("app-health",       checkAppHealth),
    timed("websocket",        checkWebSocket),
  ]);

  let allOk = true;
  for (const r of results) {
    const icon = color(r.ok);
    console.log(`  ${icon} ${r.name.padEnd(20)} ${r.ok ? r.detail : "FAIL: " + r.detail} (${r.ms}ms)`);
    if (!r.ok) allOk = false;
  }

  if (!allOk) {
    console.error(`\x1b[31m  ⚠ ${results.filter(r => !r.ok).length} check(s) failed\x1b[0m`);
  } else {
    console.log(`\x1b[32m  All checks passed\x1b[0m`);
  }
}

console.log(`✓ Kryon monitor starting`);
console.log(`  App : ${APP_URL}`);
console.log(`  WS  : ${WS_URL}`);
console.log(`  Interval: ${CHECK_INTERVAL_MS / 1000}s`);

runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);
