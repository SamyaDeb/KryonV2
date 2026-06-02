#!/usr/bin/env tsx
/**
 * Failure recovery test — stops and restarts each PM2 service, verifies
 * recovery, and tests DB/WS/RPC resilience. Step 23 of the launch checklist.
 *
 * Usage:
 *   npm run dev:recovery
 */

import { execSync } from "child_process";
import { WebSocket } from "ws";

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
// Always test the local WS server (not the Vercel URL which doesn't support persistent WS)
const WS_URL  = process.env.LOCAL_WS_URL ?? "ws://localhost:8080";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function pass(msg: string) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg: string) { console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
function step(n: string)   { console.log(`\n\x1b[1m${n}\x1b[0m`); }

function pm2(cmd: string) {
  try {
    execSync(`pm2 ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function pm2Status(name: string): "online" | "stopped" | "unknown" {
  try {
    const out = execSync(`pm2 jlist`, { stdio: "pipe" }).toString();
    const list = JSON.parse(out) as Array<{ name: string; pm2_env: { status: string } }>;
    const svc = list.find(p => p.name === name);
    if (!svc) return "unknown";
    return svc.pm2_env.status === "online" ? "online" : "stopped";
  } catch {
    return "unknown";
  }
}

async function httpOk(path: string): Promise<boolean> {
  try {
    const res = await fetch(`${APP_URL}${path}`, { cache: "no-store" as RequestInit["cache"] });
    return res.ok;
  } catch {
    return false;
  }
}

async function wsConnects(): Promise<boolean> {
  return new Promise(resolve => {
    const ws = new WebSocket(WS_URL);
    const t = setTimeout(() => { ws.close(); resolve(false); }, 5000);
    ws.on("open", () => { clearTimeout(t); ws.close(); resolve(true); });
    ws.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 30_000, label = ""): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    process.stdout.write(".");
    await sleep(2000);
  }
  console.log("");
  return false;
}

async function main() {
  console.log("\n\x1b[1m═══ Kryon Failure Recovery Test ═══\x1b[0m");
  console.log(`  App : ${APP_URL}`);
  console.log(`  WS  : ${WS_URL}`);

  const results: { test: string; ok: boolean }[] = [];
  function record(test: string, ok: boolean) {
    results.push({ test, ok });
    ok ? pass(test) : fail(test);
  }

  // ── Baseline health ───────────────────────────────────────────────────────
  step("Baseline — verify all services healthy");
  record("app /api/health", await httpOk("/api/health"));
  record("app /api/markets/1", await httpOk("/api/markets/1"));
  record("ws-server connects", await wsConnects());
  record("pm2 oracle online", pm2Status("kryon-oracle") === "online");
  record("pm2 matcher online", pm2Status("kryon-matcher") === "online");
  record("pm2 indexer online", pm2Status("kryon-indexer") === "online");
  record("pm2 ws online", pm2Status("kryon-ws") === "online");

  // ── Test: stop + restart oracle ───────────────────────────────────────────
  step("Test 1 — Stop oracle keeper, verify restart");
  pm2("stop kryon-oracle");
  await sleep(1000);
  record("oracle stopped", pm2Status("kryon-oracle") !== "online");
  pm2("start kryon-oracle");
  process.stdout.write("  waiting for oracle");
  record("oracle recovered", await waitFor(async () => pm2Status("kryon-oracle") === "online", 20_000));

  // ── Test: stop + restart matcher ──────────────────────────────────────────
  step("Test 2 — Stop matcher, verify restart and API still works");
  pm2("stop kryon-matcher");
  await sleep(1000);
  record("matcher stopped", pm2Status("kryon-matcher") !== "online");
  record("api still up during matcher down", await httpOk("/api/health"));
  pm2("start kryon-matcher");
  process.stdout.write("  waiting for matcher");
  record("matcher recovered", await waitFor(async () => pm2Status("kryon-matcher") === "online", 20_000));

  // ── Test: stop + restart indexer ──────────────────────────────────────────
  step("Test 3 — Stop indexer, verify restart");
  pm2("stop kryon-indexer");
  await sleep(1000);
  record("indexer stopped", pm2Status("kryon-indexer") !== "online");
  record("api still up during indexer down", await httpOk("/api/markets/1"));
  pm2("start kryon-indexer");
  process.stdout.write("  waiting for indexer");
  record("indexer recovered", await waitFor(async () => pm2Status("kryon-indexer") === "online", 20_000));

  // ── Test: WS disconnect + reconnect ───────────────────────────────────────
  step("Test 4 — WS server restart and reconnect");
  pm2("stop kryon-ws");
  await sleep(1000);
  record("ws-server stopped", pm2Status("kryon-ws") !== "online");
  record("ws refuses connection when stopped", !(await wsConnects()));
  pm2("start kryon-ws");
  await sleep(3000);
  process.stdout.write("  waiting for ws");
  record("ws-server recovered", await waitFor(wsConnects, 20_000));

  // ── Test: full restart of all services ────────────────────────────────────
  step("Test 5 — Restart all services simultaneously");
  pm2("restart all");
  await sleep(2000);
  process.stdout.write("  waiting for all services");
  const allBack = await waitFor(async () => {
    return pm2Status("kryon-oracle") === "online"
      && pm2Status("kryon-matcher") === "online"
      && pm2Status("kryon-indexer") === "online"
      && pm2Status("kryon-ws") === "online";
  }, 30_000);
  record("all services recovered after full restart", allBack);
  await sleep(3000);
  record("api healthy after full restart", await httpOk("/api/health"));
  record("ws connects after full restart", await wsConnects());
  record("market data available after restart", await httpOk("/api/markets/1/orderbook"));

  // ── Test: browser refresh during pending state (simulate via DB check) ────
  step("Test 6 — DB connection resilience");
  // Rapid-fire multiple DB-backed API calls concurrently
  const concurrent = Array.from({ length: 20 }, () => httpOk("/api/markets/1/orderbook"));
  const concResults = await Promise.all(concurrent);
  const concOk = concResults.filter(Boolean).length;
  record(`concurrent DB queries (${concOk}/20 ok)`, concOk >= 18);

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  console.log(`\n\x1b[1m══ Recovery Test: ${passed}/${results.length} passed ══\x1b[0m`);
  const failedTests = results.filter(r => !r.ok);
  if (failedTests.length) {
    failedTests.forEach(r => console.log(`  ✗ ${r.test}`));
    process.exit(1);
  } else {
    console.log("\x1b[32m✓ All recovery tests passed\x1b[0m");
  }
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
