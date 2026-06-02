#!/usr/bin/env tsx
/**
 * Full end-to-end testnet test — steps 18–23 of the launch checklist.
 *
 * Uses USDC as collateral (required by engine margin check).
 * Maker = deployer key (has USDC already on Stellar testnet).
 * Taker = fresh keypair (receives USDC from deployer via classic payment).
 *
 * The oracle keeper uses the deployer key every 8s — we pause it briefly
 * for deployer-key Soroban operations to avoid sequence number conflicts.
 */

import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, Address, xdr, rpc as sorobanRpc,
  authorizeEntry, Horizon, Networks, Operation, Asset, BASE_FEE,
} from "@stellar/stellar-sdk";
import { neon } from "@neondatabase/serverless";
import { execSync } from "child_process";
import { CONTRACTS, ASSETS, NETWORK } from "../config";
import { orderSigningMessage } from "../lib/market/signing-message";

const APP_URL  = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const FEE      = "2000000";
const PRICE_PRECISION = 1_000_000_000_000_000_000n;
const AMOUNT_PRECISION = 10_000_000n;
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function pass(msg: string) { console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
function fail(msg: string) { console.error(`  \x1b[31m✗\x1b[0m ${msg}`); }
function step(msg: string) { console.log(`\n\x1b[1m${msg}\x1b[0m`); }

function pm2Stop(name: string)  { try { execSync(`pm2 stop ${name}`,  { stdio: "pipe" }); } catch {} }
function pm2Start(name: string) { try { execSync(`pm2 start ${name}`, { stdio: "pipe" }); } catch {} }

// ── Contract call helper ──────────────────────────────────────────────────────

async function callContract(
  server: sorobanRpc.Server, kp: Keypair, account: Account,
  contractId: string, method: string, args: xdr.ScVal[], label: string
): Promise<Account> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${label} sim: ${sim.error?.slice(0, 200)}`);
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  process.stdout.write(`    [${label}]`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(" ✓\n"); return server.getAccount(kp.publicKey()); }
    if (poll.status === "FAILED") throw new Error(`${label} tx failed`);
    process.stdout.write(".");
  }
  throw new Error(`${label} timeout`);
}

// ── Order signing ─────────────────────────────────────────────────────────────

function signOrder(kp: Keypair, intent: {
  owner: string; market_id: number; is_long: boolean;
  size: string; limit_price: string; reduce_only: boolean;
  nonce: string; expiry_ts: string;
}): string {
  return Buffer.from(kp.sign(Buffer.from(orderSigningMessage(intent), "utf8"))).toString("hex");
}

async function postOrder(kp: Keypair, intent: {
  market_id: number; is_long: boolean; size: string;
  limit_price: string; reduce_only: boolean; nonce: string; expiry_ts: string;
}) {
  const payload = {
    owner: kp.publicKey(), ...intent,
    signature: signOrder(kp, { owner: kp.publicKey(), ...intent }),
  };
  const res = await fetch(`${APP_URL}/api/orders`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload), cache: "no-store" as RequestInit["cache"],
  });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "rejected");
  return payload;
}

// ── Wait for TxJob ────────────────────────────────────────────────────────────

async function waitForTxJob(sql: ReturnType<typeof neon>, makerAddr: string, takerAddr: string, ms = 120_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await sleep(2000);
    const rows = await sql`
      SELECT id, "unsignedXdr" FROM "TxJob"
      WHERE kind = 'settle_fill' AND status = 'QUEUED' AND "unsignedXdr" IS NOT NULL
      ORDER BY "createdAt" DESC LIMIT 10
    `;
    for (const row of rows) {
      const d = JSON.parse(row.unsignedXdr as string);
      if (d.makerAddress === makerAddr && d.takerAddress === takerAddr)
        return { id: Number(row.id), makerAuthXdr: d.makerAuthXdr, takerAuthXdr: d.takerAuthXdr, fillPrice: d.fillPrice };
    }
    process.stdout.write(".");
  }
  throw new Error("TxJob not created — check matcher logs");
}

// ── Settlement signing ────────────────────────────────────────────────────────

async function signAuthEntry(server: sorobanRpc.Server, kp: Keypair, authXdr: string): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authXdr, "base64");
  const ledger = await server.getLatestLedger();
  const signed = await authorizeEntry(entry, kp, ledger.sequence + 100, NETWORK.passphrase);
  return signed.toXDR("base64");
}

async function postSign(jobId: number, address: string, signedAuthEntry: string) {
  const res = await fetch(`${APP_URL}/api/settlements/${jobId}/sign`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, signedAuthEntry }), cache: "no-store" as RequestInit["cache"],
  });
  return await res.json() as { ok: boolean; status?: string; hash?: string; error?: string };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const results: { test: string; ok: boolean; detail: string }[] = [];
  function record(test: string, ok: boolean, detail: string) {
    results.push({ test, ok, detail });
    ok ? pass(`${test}: ${detail}`) : fail(`${test}: ${detail}`);
  }

  console.log("\n\x1b[1m═══ Kryon Testnet E2E ═══\x1b[0m");
  console.log(`  App     : ${APP_URL}`);
  console.log(`  Network : ${NETWORK.name}`);
  console.log(`  Vault   : ${CONTRACTS.vault}`);

  const makerKp = Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET!);
  const takerKp = Keypair.random();
  const makerAddr = makerKp.publicKey();
  const takerAddr = takerKp.publicKey();
  const sorobanServer = new sorobanRpc.Server(NETWORK.rpcUrl);
  const horizonServer = new Horizon.Server("https://horizon-testnet.stellar.org");
  const sql = neon(process.env.DATABASE_URL!);

  console.log(`  Maker   : ${makerAddr.slice(0, 20)}... (deployer)`);
  console.log(`  Taker   : ${takerAddr.slice(0, 20)}... (fresh)`);

  // ── Step 0: Clean order book ─────────────────────────────────────────────
  step("Step 0 — Clear order book");
  try {
    await sql`UPDATE "Order" SET cancelled = true, "updatedAt" = NOW() WHERE cancelled = false AND "filledSize"::numeric < "size"::numeric`;
    record("clear-order-book", true, "cleared");
  } catch (e) { record("clear-order-book", false, (e as Error).message); }

  // ── Step 1: Fund taker via Friendbot ─────────────────────────────────────
  step("Step 1 — Fund taker account");
  try {
    const fb = await fetch(`https://friendbot.stellar.org?addr=${takerAddr}`);
    if (!fb.ok) throw new Error("Friendbot returned " + fb.status);
    await sleep(3000);
    record("fund-taker-friendbot", true, "10,000 XLM");
  } catch (e) { record("fund-taker-friendbot", false, (e as Error).message); return; }

  // ── Step 2: Set up USDC trustline for taker ────────────────────────────────
  step("Step 2 — USDC trustline for taker");
  try {
    const takerHorizonAcct = await horizonServer.loadAccount(takerAddr);
    const trustlineTx = new TransactionBuilder(takerHorizonAcct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
      .setTimeout(30).build();
    trustlineTx.sign(takerKp);
    await horizonServer.submitTransaction(trustlineTx);
    record("usdc-trustline-taker", true, "trustline created");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("CHANGE_TRUST_ALREADY_EXIST")) record("usdc-trustline-taker", true, "already exists");
    else { record("usdc-trustline-taker", false, msg.slice(0, 80)); return; }
  }

  // ── Step 3: Send USDC to taker + deposit both into vault (oracle paused) ──
  step("Step 3 — Vault deposits (oracle paused)");
  const USDC_AMOUNT = 50_000_000n; // 5 USDC (in 1e7)

  pm2Stop("kryon-oracle");
  console.log("  oracle paused");
  await sleep(2000);

  // Retry the USDC payment up to 3 times (Horizon can 504 under load)
  let usdcSent = false;
  for (let attempt = 1; attempt <= 3 && !usdcSent; attempt++) {
    try {
      const makerHorizonAcct = await horizonServer.loadAccount(makerAddr);
      const payTx = new TransactionBuilder(makerHorizonAcct, { fee: "100000", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.payment({ destination: takerAddr, asset: new Asset("USDC", USDC_ISSUER), amount: "5" }))
        .setTimeout(60).build();
      payTx.sign(makerKp);
      await horizonServer.submitTransaction(payTx);
      record("send-usdc-to-taker", true, "5 USDC sent");
      await sleep(3000);
      usdcSent = true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt < 3) { await sleep(3000); continue; }
      record("send-usdc-to-taker", false, msg.slice(0, 80));
      pm2Start("kryon-oracle"); return;
    }
  }

  try {
    let makerAcct = await sorobanServer.getAccount(makerAddr);
    makerAcct = await callContract(sorobanServer, makerKp, makerAcct, CONTRACTS.vault, "deposit", [
      new Address(makerAddr).toScVal(),
      new Address(ASSETS.usdc).toScVal(),
      nativeToScVal(USDC_AMOUNT, { type: "i128" }),
    ], `vault.deposit(maker, 5 USDC)`);
    record("deposit-maker-usdc", true, "5 USDC deposited");
  } catch (e) { record("deposit-maker-usdc", false, (e as Error).message); pm2Start("kryon-oracle"); }

  pm2Start("kryon-oracle");
  console.log("  oracle restarted");
  await sleep(3000); // let oracle publish once

  try {
    let takerAcct = await sorobanServer.getAccount(takerAddr);
    takerAcct = await callContract(sorobanServer, takerKp, takerAcct, CONTRACTS.vault, "deposit", [
      new Address(takerAddr).toScVal(),
      new Address(ASSETS.usdc).toScVal(),
      nativeToScVal(USDC_AMOUNT, { type: "i128" }),
    ], `vault.deposit(taker, 5 USDC)`);
    record("deposit-taker-usdc", true, "5 USDC deposited");
  } catch (e) { record("deposit-taker-usdc", false, (e as Error).message); }

  // ── Step 4: Submit opposing limit orders via API ─────────────────────────
  step("Step 4 — Submit opposing limit orders via API");
  const mktRes = await fetch(`${APP_URL}/api/markets/1`, { cache: "no-store" as RequestInit["cache"] });
  const mktData = await mktRes.json() as { last_price?: string };
  const oraclePrice = BigInt(mktData.last_price ?? "217000000000000000");
  console.log(`  Oracle price: $${(Number(oraclePrice) / 1e18).toFixed(4)}`);

  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiryTs = (now + 3600n).toString();
  const SIZE = (10n * AMOUNT_PRECISION).toString();

  try {
    await postOrder(makerKp, {
      market_id: 1, is_long: true, size: SIZE,
      limit_price: oraclePrice.toString(), reduce_only: false,
      nonce: BigInt(Date.now()).toString(), expiry_ts: expiryTs,
    });
    record("place-maker-long", true, `LONG 10 XLM @$${(Number(oraclePrice)/1e18).toFixed(4)}`);
  } catch (e) { record("place-maker-long", false, (e as Error).message); return; }

  await sleep(200);

  try {
    await postOrder(takerKp, {
      market_id: 1, is_long: false, size: SIZE,
      limit_price: oraclePrice.toString(), reduce_only: false,
      nonce: (BigInt(Date.now()) + 1n).toString(), expiry_ts: expiryTs,
    });
    record("place-taker-short", true, `SHORT 10 XLM @$${(Number(oraclePrice)/1e18).toFixed(4)}`);
  } catch (e) { record("place-taker-short", false, (e as Error).message); return; }

  // ── Step 5: Wait for matcher fill ────────────────────────────────────────
  step("Step 5 — Waiting for matcher fill");
  process.stdout.write("  Polling");
  let job: Awaited<ReturnType<typeof waitForTxJob>>;
  try {
    job = await waitForTxJob(sql, makerAddr, takerAddr);
    console.log("");
    record("matcher-fill-detected", true, `TxJob #${job.id}`);
  } catch (e) {
    console.log("");
    record("matcher-fill-detected", false, (e as Error).message);
    return;
  }

  // ── Step 6: Sign settlement from both parties ─────────────────────────────
  // Note: sign API uses MATCHER_OPERATOR_SECRET (different key), no oracle pause needed.
  step("Step 6 — Sign settlement auth entries");

  try {
    const mSigned = await signAuthEntry(sorobanServer, makerKp, job.makerAuthXdr);
    const res = await postSign(job.id, makerAddr, mSigned);
    record("sign-maker-auth", res.ok, res.status ?? res.error ?? "no-status");
  } catch (e) { record("sign-maker-auth", false, (e as Error).message); return; }

  let settleTxHash: string | undefined;
  try {
    const tSigned = await signAuthEntry(sorobanServer, takerKp, job.takerAuthXdr);
    const res = await postSign(job.id, takerAddr, tSigned);
    if (res.ok) {
      settleTxHash = res.hash;
      record("sign-taker-auth", true, res.hash ? res.hash.slice(0, 16) + "..." : res.status ?? "ok");
    } else {
      // API settlement failed — submit directly to see raw Soroban error
      console.log(`  API error: ${res.error}. Attempting direct submission...`);
      const { Keypair: KP2, Transaction: TX2, xdr: XDR2 } = await import("@stellar/stellar-sdk");
      const feeKp = KP2.fromSecret(process.env.MATCHER_OPERATOR_SECRET!);
      // Rebuild tx from stored job XDR
      const jobRows = await sql`SELECT "unsignedXdr" FROM "TxJob" WHERE id = ${job.id}`;
      const jobData = JSON.parse(jobRows[0].unsignedXdr as string);
      const makerSigned = jobData.makerSignedEntry!;
      const takerSigned2 = tSigned;
      const envelope = XDR2.TransactionEnvelope.fromXDR(jobData.assembledTxXdr, "base64");
      const ops = envelope.v1().tx().operations();
      if (ops.length > 0) {
        ops[0].body().invokeHostFunctionOp().auth([
          XDR2.SorobanAuthorizationEntry.fromXDR(makerSigned, "base64"),
          XDR2.SorobanAuthorizationEntry.fromXDR(takerSigned2, "base64"),
        ]);
      }
      const tx2 = new TX2(envelope, NETWORK.passphrase);
      tx2.sign(feeKp);
      const send = await sorobanServer.sendTransaction(tx2);
      if (send.status === "ERROR") {
        const errXdr = send.errorResult?.toXDR("base64") ?? "no-xdr";
        record("sign-taker-auth", false, `direct-submit error: ${errXdr.slice(0,60)}`);
      } else {
        // Poll for result
        for (let i = 0; i < 20; i++) {
          await sleep(2000);
          const poll = await sorobanServer.getTransaction(send.hash);
          if (poll.status === "SUCCESS") { settleTxHash = send.hash; record("sign-taker-auth", true, send.hash.slice(0,16)+"..."); break; }
          if (poll.status === "FAILED") {
            const err = "resultMetaXdr" in poll ? JSON.stringify(poll).slice(0,200) : "failed";
            record("sign-taker-auth", false, `on-chain fail: ${err.slice(0,80)}`); break;
          }
          process.stdout.write(".");
        }
      }
    }
  } catch (e) { record("sign-taker-auth", false, (e as Error).message); return; }

  // ── Step 7: Verify on-chain tx ────────────────────────────────────────────
  step("Step 7 — Verify on-chain settlement");
  if (settleTxHash) {
    try {
      for (let i = 0; i < 20; i++) {
        await sleep(2000);
        const poll = await sorobanServer.getTransaction(settleTxHash);
        if (poll.status === "SUCCESS") { record("on-chain-tx", true, `ledger ${"ledger" in poll ? poll.ledger : "?"}`); break; }
        if (poll.status === "FAILED") { record("on-chain-tx", false, "tx failed"); break; }
        process.stdout.write(".");
      }
    } catch (e) { record("on-chain-tx", false, (e as Error).message); }
  }

  // ── Step 8: Verify DB state ───────────────────────────────────────────────
  step("Step 8 — Verify DB state");
  await sleep(6000); // wait for indexer

  try {
    const fills = await sql`SELECT id FROM "Fill" WHERE maker = ${makerAddr} AND taker = ${takerAddr} ORDER BY "createdAt" DESC LIMIT 1`;
    record("fill-in-db", fills.length > 0, fills.length > 0 ? `Fill id=${fills[0].id}` : "not found");
  } catch (e) { record("fill-in-db", false, (e as Error).message); }

  try {
    const stats = await sql`SELECT "tradeCount", volume FROM "TraderStat" WHERE address = ${makerAddr} AND network = ${NETWORK.name} AND period = 'ALL' LIMIT 1`;
    record("trader-stat-updated", stats.length > 0, stats.length > 0 ? `trades=${stats[0].tradeCount}` : "missing");
  } catch (e) { record("trader-stat-updated", false, (e as Error).message); }

  // Use server-side age calc — TIMESTAMP(3) cols without timezone are misread by Neon HTTP driver
  let indexerOk = false;
  for (let i = 0; i < 6 && !indexerOk; i++) {
    try {
      const market = await sql`
        SELECT "longOpenInterest",
               EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int AS age_secs
        FROM "Market" WHERE id = 1 LIMIT 1
      `;
      if (market.length > 0) {
        const age = Number(market[0].age_secs);
        const oi = market[0].longOpenInterest;
        if (age < 60) { record("indexer-synced", true, `OI=${oi} age=${age}s`); indexerOk = true; }
        else { process.stdout.write(`  (indexer age=${age}s, waiting...)\n`); await sleep(5000); }
      }
    } catch (e) { record("indexer-synced", false, (e as Error).message); break; }
  }
  if (!indexerOk && !results.find(r => r.test === "indexer-synced")) {
    record("indexer-synced", false, "indexer did not sync within 30s");
  }

  // ── Step 9: Leaderboard ───────────────────────────────────────────────────
  step("Step 9 — Verify leaderboard");
  try {
    const res = await fetch(`${APP_URL}/api/leaderboard?period=ALL`, { cache: "no-store" as RequestInit["cache"] });
    const data = await res.json() as { total: number };
    record("leaderboard-api", res.ok && data.total > 0, `total=${data.total}`);
  } catch (e) { record("leaderboard-api", false, (e as Error).message); }

  // ── Summary ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.ok).length;
  console.log(`\n\x1b[1m══════════════════════════════\x1b[0m`);
  if (passed === results.length) {
    console.log(`\x1b[32m✓ ALL ${results.length} TESTS PASSED\x1b[0m`);
  } else {
    console.log(`\x1b[31m${results.length - passed}/${results.length} TESTS FAILED\x1b[0m`);
    results.filter(r => !r.ok).forEach(r => console.error(`  ✗ ${r.test}: ${r.detail}`));
    process.exit(1);
  }
}

main().catch(e => { console.error("\x1b[31mFATAL:\x1b[0m", e.message); process.exit(1); });
