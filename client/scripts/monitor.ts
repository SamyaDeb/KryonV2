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
 * Alerting (optional): set ALERT_WEBHOOK_URL to receive alerts on failures.
 * The monitor POSTs JSON {"content": "..."} — works out of the box with a
 * Discord webhook URL. For Telegram, point it at your bot's sendMessage URL
 * via a tiny relay, or use https://api.telegram.org/bot<TOKEN>/sendMessage
 * with a proxy that maps {"content"} -> {"chat_id","text"} (Telegram's API
 * expects different field names, so a direct URL will not work).
 *
 * Alerts are de-duplicated: one alert when a check starts failing, an hourly
 * reminder while it stays broken, and a recovery notice when it heals.
 *
 * Usage:
 *   npm run dev:monitor
 */

import { neon } from "@neondatabase/serverless";
import { checkProtocolActivity } from "../lib/oracle-activity";
import { WebSocket } from "ws";
import { Contract, TransactionBuilder, Keypair, Account, rpc as sorobanRpc, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, ACTIVE_MARKETS } from "../config";

const CHECK_INTERVAL_MS = 30_000;
const APP_URL = process.env.MONITOR_APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
// MONITOR_WS_URL overrides for deployments where the browser-facing WS URL
// (NEXT_PUBLIC_WS_URL) differs from what the monitor host can reach.
const WS_URL = process.env.MONITOR_WS_URL ?? process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Alert margin under the on-chain OracleGuard max_age (120s): the keeper
// heartbeats at 60s (XLM) / 90s (USDC) + ~10s confirm latency, so a healthy
// feed peaks ~100s; alerting at 110s fires before settlement actually halts.
const ORACLE_MAX_AGE_SECS = Number(process.env.ORACLE_FRESHNESS_ALERT_SECS ?? "110");
const MATCHER_LAG_WARN_SECS = 60;
const INDEXER_LAG_WARN_SECS = 60;
const DB_LATENCY_WARN_MS = 2_000;

const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const ALERT_REMINDER_MS = 60 * 60 * 1000; // hourly reminder while a check stays broken

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
    // override_guard = Some({max_age_secs: huge, max_confidence_bps: 10000}),
    // NOT None. With None the contract enforces the feed's OWN stored guard
    // (120s) and REJECTS a stale price inside the simulation (StaleOracle,
    // CoreError #6) before this code ever sees the snapshot — indistinguishable
    // from a genuinely broken oracle. Passing a permissive override makes
    // get_price always return the raw snapshot; the age check below (which
    // already knows how to tell "safely idle" from "actually stale") is the
    // sole arbiter of whether this is a problem.
    // max_confidence_bps is capped at 10000 by the contract's validate_guard
    // (rejects >10_000 as InvalidConfig) — confirmed empirically via CLI
    // against mainnet. Option::Some(guard) encodes as the map DIRECTLY, not
    // wrapped in a vec (also confirmed via `stellar contract invoke
    // --build-only` + xdr decode against the actual deployed contract).
    const permissiveGuard = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"), val: nativeToScVal(BigInt("18446744073709551615"), { type: "u64" }) }),
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: nativeToScVal(10000, { type: "u32" }) }),
    ]);
    const tx = new TransactionBuilder(account, { fee: "500000", networkPassphrase: NETWORK.passphrase })
      .addOperation(contract.call(
        "get_price",
        nativeToScVal(market.oracleSymbol, { type: "symbol" }),
        permissiveGuard // Option<OracleGuard>::Some(...) — bare map, no vec wrapper
      ))
      .setTimeout(10)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`oracle sim failed: ${sim.error?.slice(0, 80)}`);

    const result = sim.result?.retval;
    if (!result) throw new Error("oracle returned no value");

    const snap = scValToNative(result) as Record<string, unknown>;
    const publishTime = Number(snap["publish_time"] ?? 0);
    if (!publishTime) throw new Error("oracle snapshot has no publish_time");

    const ageS = Math.round((Date.now() / 1000) - publishTime);
    if (ageS > ORACLE_MAX_AGE_SECS) {
      // The keeper suspends publishing when nothing on-chain needs a price
      // (no orders/settlements/positions/deposits). Staleness while idle is
      // deliberate, not an incident — alert only if the protocol is active.
      const activity = await checkProtocolActivity(db() as never, server);
      if (!activity.active) {
        results.push(`${market.oracleSymbol}=idle (${ageS}s old, publishing suspended)`);
        continue;
      }
      throw new Error(`oracle ${market.oracleSymbol} is ${ageS}s stale (max ${ORACLE_MAX_AGE_SECS}s) while ACTIVE: ${activity.reasons.join(",")}`);
    }
    results.push(`${market.oracleSymbol}=${ageS}s old`);
  }
  return results.join(", ");
}

async function checkMatcherLag(): Promise<string> {
  const sql = db();
  // Expired orders can never match — only live resting orders indicate lag.
  // Age is computed server-side: the Neon HTTP driver misreads TIMESTAMP(3).
  const rows = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - "createdAt"))::int AS age_s FROM "Order"
    WHERE cancelled = false AND "filledSize"::numeric < "size"::numeric
      AND "limitPrice" <> '0'
      AND "expiryTs" > EXTRACT(EPOCH FROM NOW())::bigint
    ORDER BY "createdAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no resting orders";
  const ageS = Number(rows[0].age_s);
  if (ageS > MATCHER_LAG_WARN_SECS) throw new Error(`oldest pending order is ${ageS}s old`);
  return `oldest order ${ageS}s`;
}

async function checkIndexerLag(): Promise<string> {
  const sql = db();
  // Only markets the indexer actually syncs; server-side age (Neon TIMESTAMP(3) quirk).
  const activeIds = Object.values(ACTIVE_MARKETS).map((m) => m.marketId);
  const rows = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int AS age_s FROM "Market"
    WHERE id = ANY(${activeIds})
    ORDER BY "updatedAt" ASC LIMIT 1
  `;
  if (!rows.length) return "no active markets in DB";
  const ageS = Number(rows[0].age_s);
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

// ── Alerting ──────────────────────────────────────────────────────────────────

type AlertState = { failing: boolean; since: number; lastAlertAt: number; lastDetail: string };
const alertStates = new Map<string, AlertState>();

async function postAlert(content: string): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    const res = await fetch(ALERT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) console.error(`  ⚠ alert webhook returned HTTP ${res.status}`);
  } catch (e) {
    console.error(`  ⚠ alert webhook unreachable: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
  }
}

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h${mins % 60}m`;
}

// One alert on ok→fail, hourly reminders while broken, one notice on fail→ok.
async function processAlerts(results: CheckResult[]): Promise<void> {
  const now = Date.now();
  for (const r of results) {
    const prev = alertStates.get(r.name);
    if (!r.ok) {
      if (!prev?.failing) {
        alertStates.set(r.name, { failing: true, since: now, lastAlertAt: now, lastDetail: r.detail });
        await postAlert(`🔴 **Kryon ${r.name}** failing: ${r.detail}`);
      } else if (now - prev.lastAlertAt >= ALERT_REMINDER_MS) {
        prev.lastAlertAt = now;
        prev.lastDetail = r.detail;
        await postAlert(`🔁 **Kryon ${r.name}** still failing after ${fmtDuration(now - prev.since)}: ${r.detail}`);
      } else {
        prev.lastDetail = r.detail;
      }
    } else if (prev?.failing) {
      alertStates.delete(r.name);
      await postAlert(`🟢 **Kryon ${r.name}** recovered after ${fmtDuration(now - prev.since)} (${r.detail})`);
    }
  }
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

  await processAlerts(results);
}

console.log(`✓ Kryon monitor starting`);
console.log(`  App : ${APP_URL}`);
console.log(`  WS  : ${WS_URL}`);
console.log(`  Interval: ${CHECK_INTERVAL_MS / 1000}s`);
console.log(`  Alerts: ${ALERT_WEBHOOK_URL ? "webhook configured" : "disabled (set ALERT_WEBHOOK_URL)"}`);

runChecks();
setInterval(runChecks, CHECK_INTERVAL_MS);
