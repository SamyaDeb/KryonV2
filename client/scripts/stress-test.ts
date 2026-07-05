#!/usr/bin/env tsx
/**
 * Economic stress test — exercises the LIVE testnet deployment with small sizes.
 *
 * Scenarios (STRESS_SCENARIOS=a,b,c to select, default all):
 *   a) oracle gap    — settle a baseline trade, pause the oracle keeper 90s and
 *                      verify settlement fail-stops, then verify recovery.
 *   b) liquidation   — open a position near max leverage with a throwaway
 *                      wallet, push the mark down with a synthetic oracle
 *                      publish (oracle keeper paused), verify kryon-liquidator
 *                      closes it and the vault/insurance accounting conserves
 *                      value across the involved accounts.
 *   c) burst load    — run load-test.ts at 2x default concurrency.
 *
 * Operational notes:
 *   - The maker key is ORACLE_PUBLISHER_SECRET (shared with the oracle keeper);
 *     any maker chain tx pauses kryon-oracle around it, exactly like soak-test.
 *   - Scenario b publishes a synthetic XLM price. TESTNET ONLY.
 *
 * Usage:
 *   npm run dev:stress
 *   STRESS_SCENARIOS=b npm run dev:stress
 */

import {
  Keypair,
  Account,
  Contract,
  hash,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Address,
  xdr,
  rpc as sorobanRpc,
  Horizon,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { neon } from "@neondatabase/serverless";
import { execSync } from "child_process";
import { CONTRACTS, ASSETS, NETWORK, MARKETS } from "../config";
import { orderSettlementMessage, pubkeyHexFromAddress } from "../lib/market/signing-message";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const FEE = "2000000";
const AMOUNT_PRECISION = 10_000_000n; // 1e7 (sizes, USDC amounts)
const PRICE_PRECISION = 1_000_000_000_000_000_000n; // 1e18

const SCENARIOS = (process.env.STRESS_SCENARIOS ?? "a,b,c").split(",").map((s) => s.trim());

const server = new sorobanRpc.Server(NETWORK.rpcUrl);
const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
const sql = neon(process.env.DATABASE_URL!);
const makerKp = Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET!);

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function pm2Stop(n: string) { try { execSync(`pm2 stop ${n}`, { stdio: "pipe" }); } catch {} }
function pm2Start(n: string) { try { execSync(`pm2 start ${n}`, { stdio: "pipe" }); } catch {} }
function log(msg: string) { console.log(`  ${msg}`); }

interface ScenarioResult { name: string; pass: boolean; notes: string[] }
const results: ScenarioResult[] = [];

// ── Chain helpers ─────────────────────────────────────────────────────────────

const simKp = Keypair.random();
let simSeq = 1000;

async function simulateRead(contractId: string, method: string, args: xdr.ScVal[]): Promise<unknown | null> {
  const account = new Account(simKp.publicKey(), (simSeq++).toString());
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  try {
    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) return null;
    const retval = (sim as sorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!retval) return null;
    return scValToNative(retval);
  } catch {
    return null; // transient RPC failure — callers treat null as "unknown"
  }
}

async function callContract(kp: Keypair, contractId: string, method: string, args: xdr.ScVal[]): Promise<void> {
  // Retry the pre-send phase on transient RPC failures — nothing has been
  // submitted yet, so this is always safe. Simulation errors are NOT retried:
  // they are deterministic contract rejections.
  let send: Awaited<ReturnType<typeof server.sendTransaction>> | null = null;
  for (let attempt = 0; send === null; attempt++) {
    try {
      const account = await server.getAccount(kp.publicKey());
      const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
        .addOperation(new Contract(contractId).call(method, ...args))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${method} sim: ${sim.error?.slice(0, 120)}`);
      const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
      prepared.sign(kp);
      send = await server.sendTransaction(prepared);
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const transient = /ETIMEDOUT|ECONNRESET|fetch failed|socket|network|timeout of/i.test(msg);
      if (!transient || attempt >= 4) throw e;
      log(`(${method}: transient RPC error, retrying — ${msg.slice(0, 50)})`);
      await sleep(5000);
    }
  }
  if (send.status === "ERROR") throw new Error(`${method} submit failed`);
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    try {
      const p = await server.getTransaction(send.hash);
      if (p.status === "SUCCESS") return;
      if (p.status === "FAILED") throw new Error(`${method} failed on-chain (${send.hash})`);
    } catch (e) {
      if (/failed on-chain/.test((e as Error).message)) throw e;
      // transient poll failure — keep polling
    }
  }
  throw new Error(`${method} confirm timeout`);
}

function toI128(v: bigint): xdr.ScVal { return nativeToScVal(v, { type: "i128" }); }

async function writePrice(symbol: string, price: bigint): Promise<void> {
  // Testnet RPC confirmation can be flaky — retry; write_price is idempotent
  // for our purposes (monotonic publish_time is regenerated per attempt).
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await callContract(makerKp, CONTRACTS.oracleAdapter, "write_price", [
        nativeToScVal(symbol, { type: "symbol" }),
        nativeToScVal(makerKp.publicKey(), { type: "address" }),
        toI128(price),
        toI128(price / 1000n), // 0.1% confidence
        nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: "u64" }),
      ]);
      return;
    } catch (e) {
      lastErr = e as Error;
      log(`(write_price attempt ${attempt + 1} failed: ${lastErr.message.slice(0, 50)} — retrying)`);
      await sleep(5000);
    }
  }
  throw lastErr;
}

async function oraclePrice(symbol: string): Promise<bigint> {
  const res = (await simulateRead(CONTRACTS.oracleAdapter, "get_price", [
    nativeToScVal(symbol, { type: "symbol" }),
    xdr.ScVal.scvVoid(),
  ])) as Record<string, unknown> | null;
  if (!res) throw new Error(`oracle get_price(${symbol}) unavailable`);
  return BigInt(res["price"] as string | bigint | number);
}

// balance_of never legitimately fails — retry so a transient RPC blip can't
// corrupt the conservation accounting.
async function readWithRetry(contractId: string, method: string, args: xdr.ScVal[]): Promise<bigint> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await simulateRead(contractId, method, args);
    if (res !== null) return BigInt(res as string | bigint | number);
    await sleep(3000);
  }
  throw new Error(`${method} read failed after retries`);
}

async function vaultBalance(user: string): Promise<bigint> {
  return readWithRetry(CONTRACTS.vault, "balance_of", [
    new Address(user).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
  ]);
}

async function insuranceBalance(): Promise<{ balance: bigint; badDebt: bigint }> {
  return {
    balance: await readWithRetry(CONTRACTS.insurance, "balance_of", [new Address(ASSETS.usdc).toScVal()]),
    badDebt: await readWithRetry(CONTRACTS.insurance, "bad_debt_of", [new Address(ASSETS.usdc).toScVal()]),
  };
}

// null = read failed (unknown state) — callers must NOT treat it as "no positions".
async function positionsOf(user: string): Promise<Array<Record<string, unknown>> | null> {
  const res = await simulateRead(CONTRACTS.engine, "positions", [new Address(user).toScVal()]);
  return Array.isArray(res) ? res : null;
}

async function accountHealth(user: string): Promise<Record<string, unknown> | null> {
  return (await simulateRead(CONTRACTS.vault, "account_health", [
    new Address(user).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
  ])) as Record<string, unknown> | null;
}

// ── Wallet + order helpers (mirrors soak-test) ────────────────────────────────

async function fundThrowaway(usdcAmount: string): Promise<Keypair> {
  const kp = Keypair.random();
  const fb = await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`);
  if (!fb.ok) throw new Error("friendbot failed");
  await sleep(4000);
  const acct = await horizon.loadAccount(kp.publicKey());
  const trust = new TransactionBuilder(acct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(30)
    .build();
  trust.sign(kp);
  await horizon.submitTransaction(trust);
  // USDC from maker (a classic-payment; consumes maker sequence — caller must
  // have paused kryon-oracle)
  const makerAcct = await horizon.loadAccount(makerKp.publicKey());
  const pay = new TransactionBuilder(makerAcct, { fee: "100000", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: kp.publicKey(), asset: new Asset("USDC", USDC_ISSUER), amount: usdcAmount }))
    .setTimeout(60)
    .build();
  pay.sign(makerKp);
  await horizon.submitTransaction(pay);
  await sleep(2000);
  return kp;
}

async function vaultDeposit(kp: Keypair, amount: bigint): Promise<void> {
  await callContract(kp, CONTRACTS.vault, "deposit", [
    new Address(kp.publicKey()).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
    toI128(amount),
  ]);
}

function signOrder(kp: Keypair, intent: Record<string, unknown>): string {
  // Sign exactly like the contract verifies (settle_fill_signed): SEP-53 —
  // ed25519 over sha256("Stellar Signed Message:\n" || canonical message).
  const message = orderSettlementMessage(
    NETWORK.passphrase,
    pubkeyHexFromAddress(kp.publicKey()),
    intent as Parameters<typeof orderSettlementMessage>[2],
  );
  const digest = hash(Buffer.concat([Buffer.from("Stellar Signed Message:\n"), Buffer.from(message, "utf8")]));
  return Buffer.from(kp.sign(digest)).toString("base64");
}

async function postOrder(kp: Keypair, intent: { market_id: number; is_long: boolean; size: string; limit_price: string; reduce_only: boolean; nonce: string; expiry_ts: string }): Promise<void> {
  const payload = { owner: kp.publicKey(), ...intent, signature: signOrder(kp, { owner: kp.publicKey(), ...intent }) };
  const res = await fetch(`${APP_URL}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store" as RequestInit["cache"],
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "order rejected");
}

async function maxFillId(): Promise<bigint> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await sql`SELECT COALESCE(MAX(id), 0) AS max FROM "Fill"`;
      return BigInt(rows[0].max as string | number);
    } catch (e) {
      if (attempt >= 5) throw e;
      await sleep(3000);
    }
  }
}

/**
 * The matcher settles signed orders autonomously (settle_fill_signed) — no
 * client-side auth signing. A Fill row alone is NOT settlement: persistFill
 * writes it before the chain tx and rolls it back on failure. Require the
 * matching TxJob (payloadHash = Fill.txHash) to be CONFIRMED with a real
 * submitted hash.
 */
async function waitForFill(a: string, b: string, sinceId: bigint, timeoutMs: number): Promise<{ txHash: string; fillPrice: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(3000);
    // Neon's HTTP driver occasionally times out — a transient blip must not
    // abort a multi-minute scenario, so treat query errors as "not yet".
    let rows: Record<string, unknown>[];
    try {
      rows = await sql`
        SELECT f."txHash", f."fillPrice", t."submittedHash" FROM "Fill" f
        JOIN "TxJob" t ON t."payloadHash" = f."txHash" AND t.kind = 'settle_fill' AND t.status = 'CONFIRMED'
        WHERE f.id > ${sinceId.toString()}::bigint AND f.maker IN (${a}, ${b}) AND f.taker IN (${a}, ${b})
        ORDER BY f.id DESC LIMIT 1
      `;
    } catch (e) {
      log(`(transient DB error during fill poll: ${(e as Error).message.slice(0, 60)})`);
      continue;
    }
    if (rows.length) return { txHash: (rows[0].submittedHash ?? rows[0].txHash) as string, fillPrice: rows[0].fillPrice as string };
  }
  return null;
}

/** Post a crossed pair (first order rests, second crosses) and await settlement. */
async function postCrossedPair(longKp: Keypair, shortKp: Keypair, size: bigint, price: bigint, timeoutMs = 90_000) {
  const sinceId = await maxFillId();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = (now + 3600n).toString();
  await postOrder(longKp, { market_id: 1, is_long: true, size: size.toString(), limit_price: price.toString(), reduce_only: false, nonce: BigInt(Date.now()).toString(), expiry_ts: expiry });
  await postOrder(shortKp, { market_id: 1, is_long: false, size: size.toString(), limit_price: price.toString(), reduce_only: false, nonce: (BigInt(Date.now()) + 1n).toString(), expiry_ts: expiry });
  return waitForFill(longKp.publicKey(), shortKp.publicKey(), sinceId, timeoutMs);
}

const fmtUsdc = (v: bigint) => (Number(v) / Number(AMOUNT_PRECISION)).toFixed(4);

// ── Scenario A: oracle gap ────────────────────────────────────────────────────

async function scenarioOracleGap(): Promise<ScenarioResult> {
  const notes: string[] = [];
  console.log("\n\x1b[1m── Scenario A: oracle gap (fail-stop + recovery) ──\x1b[0m");

  // Setup: fund throwaway taker; deposit both sides (oracle paused for maker txs)
  pm2Stop("kryon-oracle");
  const takerKp = await fundThrowaway("6");
  await vaultDeposit(makerKp, 5n * AMOUNT_PRECISION);
  pm2Start("kryon-oracle");
  await sleep(10_000);
  await vaultDeposit(takerKp, 5n * AMOUNT_PRECISION);
  log(`taker ${takerKp.publicKey().slice(0, 8)}… funded + deposited 5 USDC`);

  const size = 5n * AMOUNT_PRECISION; // 5 XLM ≈ $1 notional
  const price = await oraclePrice("XLM");

  // 1. Baseline settle
  const baseFill = await postCrossedPair(takerKp, makerKp, size, price);
  if (!baseFill) return { name: "a-oracle-gap", pass: false, notes: ["baseline: no settlement within 90s — cannot continue"] };
  notes.push(`baseline settle OK (${baseFill.txHash.slice(0, 12)}…)`);
  log(`baseline settle OK`);

  // 2. Pause the oracle past the engine's staleness tolerance, then attempt a
  // trade mid-gap. The deployed XLM-PERP config has max_oracle_age_secs=120,
  // so anything settled before 120s of staleness is within design tolerance —
  // wait 130s to probe the actual fail-stop boundary.
  pm2Stop("kryon-oracle");
  log("oracle paused — waiting 130s (> max_oracle_age_secs=120)…");
  await sleep(130_000);
  let gapBlocked = false;
  try {
    const gapFill = await postCrossedPair(takerKp, makerKp, size, price, 45_000);
    if (!gapFill) {
      gapBlocked = true;
      notes.push("gap: fail-stop OK — no settlement against a >90s-stale oracle");
    } else {
      notes.push(`gap: !! trade SETTLED against a >90s-stale oracle (${gapFill.txHash.slice(0, 12)}…) — fail-stop MISSING`);
    }
  } finally {
    pm2Start("kryon-oracle");
  }
  log(gapBlocked ? "gap correctly blocked" : "GAP NOT BLOCKED");
  await sleep(15_000); // let oracle publish fresh prices

  // 3. Recovery
  const freshPrice = await oraclePrice("XLM");
  const recFill = await postCrossedPair(takerKp, makerKp, size, freshPrice, 120_000);
  let recovered = false;
  if (recFill) {
    recovered = true;
    notes.push(`recovery settle OK (${recFill.txHash.slice(0, 12)}…)`);
  } else {
    notes.push("recovery: no settlement within 120s after oracle resumed");
  }
  log(recovered ? "recovery settle OK" : "RECOVERY FAILED");

  return { name: "a-oracle-gap", pass: gapBlocked && recovered, notes };
}

// ── Scenario B: liquidation path ──────────────────────────────────────────────

async function scenarioLiquidation(): Promise<ScenarioResult> {
  const notes: string[] = [];
  console.log("\n\x1b[1m── Scenario B: liquidation near max leverage ──\x1b[0m");

  // Throwaway victim W: 5 USDC collateral. Maker takes the short side (10 USDC).
  pm2Stop("kryon-oracle");
  const wKp = await fundThrowaway("6");
  await vaultDeposit(makerKp, 10n * AMOUNT_PRECISION);
  pm2Start("kryon-oracle");
  await sleep(10_000);
  await vaultDeposit(wKp, 5n * AMOUNT_PRECISION);
  log(`victim ${wKp.publicKey().slice(0, 8)}… deposited 5 USDC`);

  // Open W long at ~8x (initial margin floor is 10% ⇒ max 10x): notional 40 USDC.
  const price = await oraclePrice("XLM");
  const priceHuman = Number(price) / Number(PRICE_PRECISION);
  const sizeXlm = BigInt(Math.floor((40 / priceHuman))) * AMOUNT_PRECISION;
  log(`XLM=$${priceHuman.toFixed(4)} → opening ${sizeXlm / AMOUNT_PRECISION} XLM long (~40 USDC notional, ~8x)`);
  const fill = await postCrossedPair(wKp, makerKp, sizeXlm, price);
  if (!fill) return { name: "b-liquidation", pass: false, notes: ["open: no settlement within 90s"] };
  const posBefore = await positionsOf(wKp.publicKey());
  if (!posBefore?.length) return { name: "b-liquidation", pass: false, notes: ["open: settled but no on-chain position found"] };
  notes.push(`opened position: ${sizeXlm / AMOUNT_PRECISION} XLM long @ $${priceHuman.toFixed(4)} on 5 USDC margin`);

  // Snapshot balances for the conservation check
  const liqPub = process.env.LIQUIDATOR_SECRET
    ? Keypair.fromSecret(process.env.LIQUIDATOR_SECRET).publicKey()
    : null;
  const pre = {
    w: await vaultBalance(wKp.publicKey()),
    maker: await vaultBalance(makerKp.publicKey()),
    liquidator: liqPub ? await vaultBalance(liqPub) : 0n,
    insurance: await insuranceBalance(),
  };

  // Push the mark down 10% with a synthetic publish (TESTNET ONLY).
  pm2Stop("kryon-oracle");
  const crashed = (price * 90n) / 100n;
  try {
    await writePrice("XLM", crashed);
    await writePrice("USDC", PRICE_PRECISION); // keep collateral price fresh
    log(`synthetic XLM price published: $${(Number(crashed) / Number(PRICE_PRECISION)).toFixed(4)} (-10%)`);

    const health = await accountHealth(wKp.publicKey());
    notes.push(`post-crash health: liquidatable=${health?.["liquidatable"]}, equity=${health?.["equity"]}`);
    if (!health?.["liquidatable"]) {
      notes.push("!! position not flagged liquidatable after -10% — check margin math");
      return { name: "b-liquidation", pass: false, notes };
    }

    // kryon-liquidator polls every 5s — keep the synthetic price fresh while we wait.
    log("waiting for kryon-liquidator…");
    let liquidated = false;
    for (let i = 0; i < 24; i++) {
      await sleep(10_000);
      if (i % 3 === 2) { try { await writePrice("XLM", crashed); await writePrice("USDC", PRICE_PRECISION); } catch {} }
      const pos = await positionsOf(wKp.publicKey());
      if (pos !== null && (pos.length === 0 || pos.every((p) => BigInt((p["size"] as string | bigint) ?? 0) === 0n))) {
        liquidated = true;
        break;
      }
    }
    if (!liquidated) {
      notes.push("!! liquidator did not close the position within 4 min");
      return { name: "b-liquidation", pass: false, notes };
    }
    notes.push("position fully liquidated by kryon-liquidator");
    log("position liquidated ✓");
  } finally {
    pm2Start("kryon-oracle");
  }
  await sleep(15_000); // real prices resume

  // Conservation: value moved between W, maker, insurance, liquidator — but the
  // sum across them (plus recorded bad debt) must not change.
  const post = {
    w: await vaultBalance(wKp.publicKey()),
    maker: await vaultBalance(makerKp.publicKey()),
    liquidator: liqPub ? await vaultBalance(liqPub) : 0n,
    insurance: await insuranceBalance(),
  };

  const preSum = pre.w + pre.maker + pre.liquidator + pre.insurance.balance;
  const postSum = post.w + post.maker + post.liquidator + post.insurance.balance;
  const drift = postSum - preSum;
  notes.push(`balances (USDC) W: ${fmtUsdc(pre.w)}→${fmtUsdc(post.w)}, maker: ${fmtUsdc(pre.maker)}→${fmtUsdc(post.maker)}, insurance: ${fmtUsdc(pre.insurance.balance)}→${fmtUsdc(post.insurance.balance)}, liquidator: ${fmtUsdc(pre.liquidator)}→${fmtUsdc(post.liquidator)}`);
  notes.push(`bad debt: ${fmtUsdc(pre.insurance.badDebt)}→${fmtUsdc(post.insurance.badDebt)}`);
  notes.push(`closed-system drift (post−pre, should be ≤0 and small; fees may exit): ${fmtUsdc(drift)} USDC`);

  // Note: maker keeps an open short with unrealized PnL — its vault balance
  // reflects realized flows only, so drift here measures realized conservation.
  const pass = drift <= 0n && -drift < 1n * AMOUNT_PRECISION; // ≤1 USDC unexplained outflow
  if (!pass) notes.push("!! conservation drift exceeds 1 USDC — investigate before mainnet");
  return { name: "b-liquidation", pass, notes };
}

// ── Scenario C: burst load ────────────────────────────────────────────────────

async function scenarioBurst(): Promise<ScenarioResult> {
  console.log("\n\x1b[1m── Scenario C: burst load (2x) ──\x1b[0m");
  try {
    execSync("npx tsx scripts/load-test.ts", {
      stdio: "inherit",
      env: { ...process.env, CONCURRENCY: "40", DURATION_SECS: "30" },
    });
    return { name: "c-burst-load", pass: true, notes: ["load-test.ts at CONCURRENCY=40 (2x default): all endpoints healthy"] };
  } catch {
    return { name: "c-burst-load", pass: false, notes: ["load-test.ts at CONCURRENCY=40 reported unhealthy endpoints (see output above)"] };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n\x1b[1m═══ Kryon Economic Stress Test ═══\x1b[0m`);
  console.log(`  Network   : ${NETWORK.name}`);
  console.log(`  App       : ${APP_URL}`);
  console.log(`  Scenarios : ${SCENARIOS.join(", ")}`);
  if (NETWORK.name !== "testnet") throw new Error("stress test is TESTNET ONLY (synthetic oracle publishes)");
  if (!MARKETS["XLM-PERP"]) throw new Error("XLM-PERP not configured");

  if (SCENARIOS.includes("a")) results.push(await scenarioOracleGap());
  if (SCENARIOS.includes("b")) results.push(await scenarioLiquidation());
  if (SCENARIOS.includes("c")) results.push(await scenarioBurst());

  console.log(`\n\x1b[1m══ Stress Test Results ══\x1b[0m`);
  let allPass = true;
  for (const r of results) {
    console.log(`  ${r.pass ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${r.name}`);
    for (const n of r.notes) console.log(`       - ${n}`);
    if (!r.pass) allPass = false;
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  pm2Start("kryon-oracle"); // never leave the oracle down
  console.error("FATAL:", e);
  process.exit(1);
});
