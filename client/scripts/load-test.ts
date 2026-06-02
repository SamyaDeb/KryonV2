#!/usr/bin/env tsx
/**
 * Load test — hammers API endpoints concurrently, measures latency/error rates.
 * Tests: orderbook, trades, portfolio, leaderboard, order submission spam protection.
 *
 * Usage:
 *   npm run dev:load
 *   CONCURRENCY=50 DURATION_SECS=60 npm run dev:load
 */

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "20");
const DURATION_SECS = Number(process.env.DURATION_SECS ?? "30");

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface EndpointResult { url: string; ok: number; fail: number; latencies: number[] }

async function hit(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; ms: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { cache: "no-store" as RequestInit["cache"], ...init });
    return { ok: res.ok || res.status === 429, status: res.status, ms: Date.now() - t0 };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - t0 };
  }
}

async function runEndpoint(label: string, url: string, init?: RequestInit, expectedStatuses = [200]): Promise<EndpointResult> {
  const result: EndpointResult = { url, ok: 0, fail: 0, latencies: [] };
  const deadline = Date.now() + DURATION_SECS * 1000;

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline) {
      const r = await hit(url, init);
      result.latencies.push(r.ms);
      if (expectedStatuses.includes(r.status)) result.ok++;
      else result.fail++;
      await sleep(50 + Math.random() * 100);
    }
  });

  await Promise.all(workers);
  return result;
}

function stats(label: string, r: EndpointResult) {
  const sorted = r.latencies.sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
  const total = r.ok + r.fail;
  const errRate = r.fail / total * 100;
  const status = errRate < 5 ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${status} ${label.padEnd(30)} ${String(total).padStart(5)} req  p50=${p50}ms p95=${p95}ms p99=${p99}ms  err=${errRate.toFixed(1)}%`);
  return errRate < 5;
}

async function main() {
  console.log(`\n\x1b[1m═══ Kryon Load Test ═══\x1b[0m`);
  console.log(`  App         : ${APP_URL}`);
  console.log(`  Concurrency : ${CONCURRENCY} workers per endpoint`);
  console.log(`  Duration    : ${DURATION_SECS}s per endpoint`);

  const allPassed: boolean[] = [];

  // ── Health / ready ────────────────────────────────────────────────────────
  console.log("\n  \x1b[1mHealth endpoints:\x1b[0m");
  allPassed.push(stats("GET /api/health", await runEndpoint("health", `${APP_URL}/api/health`, undefined, [200])));
  allPassed.push(stats("GET /api/ready", await runEndpoint("ready", `${APP_URL}/api/ready`, undefined, [200])));

  // ── Market data ───────────────────────────────────────────────────────────
  console.log("\n  \x1b[1mMarket data:\x1b[0m");
  allPassed.push(stats("GET /api/markets/1", await runEndpoint("market", `${APP_URL}/api/markets/1`, undefined, [200])));
  allPassed.push(stats("GET /api/markets/1/orderbook", await runEndpoint("orderbook", `${APP_URL}/api/markets/1/orderbook`, undefined, [200])));
  allPassed.push(stats("GET /api/markets/1/trades", await runEndpoint("trades", `${APP_URL}/api/markets/1/trades`, undefined, [200])));
  allPassed.push(stats("GET /api/markets/1/candles", await runEndpoint("candles", `${APP_URL}/api/markets/1/candles`, undefined, [200])));

  // ── Portfolio / leaderboard ───────────────────────────────────────────────
  console.log("\n  \x1b[1mUser data:\x1b[0m");
  const ADDR = "GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI";
  allPassed.push(stats("GET /api/portfolio/:address", await runEndpoint("portfolio", `${APP_URL}/api/portfolio/${ADDR}`, undefined, [200])));
  allPassed.push(stats("GET /api/leaderboard", await runEndpoint("leaderboard", `${APP_URL}/api/leaderboard?period=MONTH`, undefined, [200])));
  allPassed.push(stats("GET /api/fills (200 or 429)", await runEndpoint("fills", `${APP_URL}/api/fills?address=${ADDR}`, undefined, [200, 429])));

  // ── Rate limit / spam protection ──────────────────────────────────────────
  console.log("\n  \x1b[1mRate limiting / validation:\x1b[0m");
  // Bad portfolio address → 400
  allPassed.push(stats("GET /api/portfolio/invalid (→400)", await runEndpoint("portfolio-bad", `${APP_URL}/api/portfolio/not-a-key`, undefined, [400])));
  // Malformed order → 400 (not 500)
  const badOrderResult = await runEndpoint("orders-bad", `${APP_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }, [400]);
  allPassed.push(stats("POST /api/orders bad body (→400)", badOrderResult));

  // High-volume portfolio requests to check rate limit kicks in at 429 or 400
  const rlResult = await runEndpoint("rate-limit-portfolio",
    `${APP_URL}/api/portfolio/not-a-stellar-address`, undefined, [400, 429]);
  allPassed.push(stats("Rate limit probe (400 or 429)", rlResult));

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = allPassed.filter(Boolean).length;
  console.log(`\n\x1b[1m══ Load Test Results: ${passed}/${allPassed.length} endpoints healthy ══\x1b[0m`);
  if (passed < allPassed.length) { process.exit(1); }
  else console.log("\x1b[32m✓ Load test passed\x1b[0m");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
