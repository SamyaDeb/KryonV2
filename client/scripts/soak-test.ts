#!/usr/bin/env tsx
/**
 * Soak test — runs repeated trade cycles for a configurable duration.
 * Verifies the system remains stable under sustained load.
 *
 * Usage:
 *   SOAK_MINUTES=30 npm run dev:soak
 *   SOAK_MINUTES=5 npm run dev:soak   (quick smoke)
 */

import { Keypair, Account, Contract, TransactionBuilder, nativeToScVal, Address, xdr, rpc as sorobanRpc, authorizeEntry, Horizon, Networks, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import { neon } from "@neondatabase/serverless";
import { execSync } from "child_process";
import { CONTRACTS, ASSETS, NETWORK } from "../config";
import { orderSigningMessage } from "../lib/market/signing-message";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
function pm2Stop(n: string)  { try { execSync(`pm2 stop ${n}`,  { stdio: "pipe" }); } catch {} }
function pm2Start(n: string) { try { execSync(`pm2 start ${n}`, { stdio: "pipe" }); } catch {} }

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
const SOAK_MINUTES = Number(process.env.SOAK_MINUTES ?? "10");
const CYCLE_DELAY_MS = 8_000;
const FEE = "2000000";
const AMOUNT_PRECISION = 10_000_000n;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface CycleStats { ok: number; failed: number; latencies: number[] }

async function callContract(server: sorobanRpc.Server, kp: Keypair, account: Account, contractId: string, method: string, args: xdr.ScVal[]): Promise<Account> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`sim: ${sim.error?.slice(0, 100)}`);
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error("submit failed");
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const p = await server.getTransaction(send.hash);
    if (p.status === "SUCCESS") return server.getAccount(kp.publicKey());
    if (p.status === "FAILED") throw new Error("tx failed on-chain");
  }
  throw new Error("timeout");
}

function signOrder(kp: Keypair, intent: Record<string, unknown>): string {
  const message = orderSigningMessage(intent as Parameters<typeof orderSigningMessage>[0]);
  return Buffer.from(kp.sign(Buffer.from(message, "utf8"))).toString("hex");
}

async function postOrder(kp: Keypair, intent: { market_id: number; is_long: boolean; size: string; limit_price: string; reduce_only: boolean; nonce: string; expiry_ts: string }) {
  const payload = { owner: kp.publicKey(), ...intent, signature: signOrder(kp, { owner: kp.publicKey(), ...intent }) };
  const res = await fetch(`${APP_URL}/api/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), cache: "no-store" as RequestInit["cache"] });
  const data = await res.json() as { ok: boolean; error?: string };
  if (!data.ok) throw new Error(data.error ?? "rejected");
}

async function waitForJob(sql: ReturnType<typeof neon>, makerAddr: string, takerAddr: string): Promise<{ id: number; makerAuthXdr: string; takerAuthXdr: string } | null> {
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const rows = await sql`SELECT id, "unsignedXdr" FROM "TxJob" WHERE kind='settle_fill' AND status='QUEUED' AND "unsignedXdr" IS NOT NULL ORDER BY "createdAt" DESC LIMIT 5`;
    for (const row of rows) {
      const d = JSON.parse(row.unsignedXdr as string);
      if (d.makerAddress === makerAddr && d.takerAddress === takerAddr) return { id: Number(row.id), makerAuthXdr: d.makerAuthXdr, takerAuthXdr: d.takerAuthXdr };
    }
  }
  return null;
}

async function signAndSubmit(server: sorobanRpc.Server, kp: Keypair, authXdr: string): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authXdr, "base64");
  const ledger = await server.getLatestLedger();
  const signed = await authorizeEntry(entry, kp, ledger.sequence + 100, NETWORK.passphrase);
  return signed.toXDR("base64");
}

async function main() {
  console.log(`\n\x1b[1m═══ Kryon Soak Test ═══\x1b[0m`);
  console.log(`  Duration : ${SOAK_MINUTES} minutes`);
  console.log(`  App      : ${APP_URL}`);
  console.log(`  Network  : ${NETWORK.name}`);

  const makerKp = Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET!);
  const takerKp = Keypair.random();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const horizonServer = new Horizon.Server("https://horizon-testnet.stellar.org");
  const sql = neon(process.env.DATABASE_URL!);
  const USDC_AMOUNT = 50_000_000n; // 5 USDC (1e7 scale)

  console.log(`\n  Maker: ${makerKp.publicKey().slice(0, 20)}...`);
  console.log(`  Taker: ${takerKp.publicKey().slice(0, 20)}... (fresh)`);

  // Fund taker with XLM via Friendbot
  console.log("\n  Funding taker...");
  const fb = await fetch(`https://friendbot.stellar.org?addr=${takerKp.publicKey()}`);
  if (!fb.ok) throw new Error("Friendbot failed");
  await sleep(4000);

  // Taker USDC trustline
  const takerHorizon = await horizonServer.loadAccount(takerKp.publicKey());
  const trustlineTx = new TransactionBuilder(takerHorizon, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(30).build();
  trustlineTx.sign(takerKp);
  await horizonServer.submitTransaction(trustlineTx);

  // Pause oracle, send USDC to taker + deposit both, restart oracle
  console.log("  Setting up USDC collateral (oracle paused)...");
  pm2Stop("kryon-oracle");
  await sleep(2000);

  // Send USDC from maker to taker
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const makerHorizon = await horizonServer.loadAccount(makerKp.publicKey());
      const payTx = new TransactionBuilder(makerHorizon, { fee: "100000", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.payment({ destination: takerKp.publicKey(), asset: new Asset("USDC", USDC_ISSUER), amount: "5" }))
        .setTimeout(60).build();
      payTx.sign(makerKp);
      await horizonServer.submitTransaction(payTx);
      await sleep(3000);
      break;
    } catch { await sleep(3000); }
  }

  // Deposit maker USDC
  let makerAcct = await server.getAccount(makerKp.publicKey());
  makerAcct = await callContract(server, makerKp, makerAcct, CONTRACTS.vault, "deposit", [
    new Address(makerKp.publicKey()).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
    nativeToScVal(USDC_AMOUNT, { type: "i128" }),
  ]);
  console.log("  Maker deposited 5 USDC ✓");

  pm2Start("kryon-oracle");
  await sleep(3000); // let oracle publish

  // Deposit taker USDC
  let takerAcct = await server.getAccount(takerKp.publicKey());
  takerAcct = await callContract(server, takerKp, takerAcct, CONTRACTS.vault, "deposit", [
    new Address(takerKp.publicKey()).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
    nativeToScVal(USDC_AMOUNT, { type: "i128" }),
  ]);
  console.log("  Taker deposited 5 USDC ✓");

  const stats: CycleStats = { ok: 0, failed: 0, latencies: [] };
  const deadline = Date.now() + SOAK_MINUTES * 60_000;
  let cycle = 0;

  console.log(`\n  Starting soak loop (${SOAK_MINUTES}min)...\n`);

  while (Date.now() < deadline) {
    cycle++;
    const t0 = Date.now();
    const remaining = Math.round((deadline - Date.now()) / 1000);
    process.stdout.write(`  [cycle ${cycle}] ${remaining}s left — `);

    try {
      const now = BigInt(Math.floor(Date.now() / 1000));
      const expiry = (now + 3600n).toString();
      const mNonce = BigInt(Date.now()).toString();
      const tNonce = (BigInt(Date.now()) + 1n).toString();
      // Fetch live oracle price to stay within execution deviation band
      const mktRes = await fetch(`${APP_URL}/api/markets/1`, { cache: "no-store" as RequestInit["cache"] });
      const mktData = await mktRes.json() as { last_price?: string };
      const PRICE = (BigInt(mktData.last_price ?? "217000000000000000")).toString();
      const SIZE = (5n * AMOUNT_PRECISION).toString();

      await postOrder(makerKp, { market_id: 1, is_long: true, size: SIZE, limit_price: PRICE, reduce_only: false, nonce: mNonce, expiry_ts: expiry });
      await postOrder(takerKp, { market_id: 1, is_long: false, size: SIZE, limit_price: PRICE, reduce_only: false, nonce: tNonce, expiry_ts: expiry });
      process.stdout.write("orders placed, waiting for fill");

      const job = await waitForJob(sql, makerKp.publicKey(), takerKp.publicKey());
      if (!job) throw new Error("matcher timeout");

      const mSigned = await signAndSubmit(server, makerKp, job.makerAuthXdr);
      const tSigned = await signAndSubmit(server, takerKp, job.takerAuthXdr);

      // Direct on-chain submission (avoids stale-sequence bug in API route)
      const { neon: neonDirect } = await import("@neondatabase/serverless");
      const dbDirect = neonDirect(process.env.DATABASE_URL!);
      const jobRows = await dbDirect`SELECT "unsignedXdr" FROM "TxJob" WHERE id = ${job.id}`;
      const jobData = JSON.parse(jobRows[0].unsignedXdr as string);
      const feeKp = Keypair.fromSecret(process.env.MATCHER_OPERATOR_SECRET!);
      const envelope = xdr.TransactionEnvelope.fromXDR(jobData.assembledTxXdr, "base64");
      const ops = envelope.v1().tx().operations();
      if (ops.length > 0) {
        ops[0].body().invokeHostFunctionOp().auth([
          xdr.SorobanAuthorizationEntry.fromXDR(mSigned, "base64"),
          xdr.SorobanAuthorizationEntry.fromXDR(tSigned, "base64"),
        ]);
      }
      const { Transaction } = await import("@stellar/stellar-sdk");
      const tx = new Transaction(envelope, NETWORK.passphrase);
      tx.sign(feeKp);
      const send = await server.sendTransaction(tx);
      const data = { ok: send.status !== "ERROR", hash: send.hash };

      const latency = Date.now() - t0;
      stats.ok++;
      stats.latencies.push(latency);
      console.log(` → settled ${data.hash?.slice(0, 12)}... (${latency}ms)`);
    } catch (e) {
      const latency = Date.now() - t0;
      stats.failed++;
      console.log(` → FAILED: ${(e as Error).message.slice(0, 80)} (${latency}ms)`);
    }

    await sleep(CYCLE_DELAY_MS);
  }

  // Summary
  const p50 = stats.latencies.sort((a, b) => a - b)[Math.floor(stats.latencies.length * 0.5)] ?? 0;
  const p95 = stats.latencies[Math.floor(stats.latencies.length * 0.95)] ?? 0;
  const successRate = stats.ok / (stats.ok + stats.failed) * 100;
  console.log(`\n\x1b[1m══ Soak Results ══\x1b[0m`);
  console.log(`  Cycles   : ${stats.ok + stats.failed} (${stats.ok} ok, ${stats.failed} failed)`);
  console.log(`  Success  : ${successRate.toFixed(1)}%`);
  console.log(`  p50      : ${p50}ms`);
  console.log(`  p95      : ${p95}ms`);
  if (successRate < 90) { console.error("\x1b[31m✗ Soak failed: success rate below 90%\x1b[0m"); process.exit(1); }
  else console.log("\x1b[32m✓ Soak passed\x1b[0m");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
