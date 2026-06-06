#!/usr/bin/env tsx
/**
 * Oracle Keeper — writes live active-market prices from Binance to the
 * perp-oracle-adapter contract.
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
const PUBLISH_INTERVAL_MS = 8_000; // every 8s — oracle guard max_age is 60s
const ORACLE_MARKETS = Object.values(ACTIVE_MARKETS).map((m) => ({
  symbol: m.symbol,
  oracleSymbol: m.oracleSymbol,
  priceSourceSymbol: m.priceSourceSymbol,
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function toI128ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function toU64ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

async function fetchBinancePrice(priceSourceSymbol: string): Promise<{ price: bigint; confidence: bigint; publishTime: bigint }> {
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(priceSourceSymbol)}`;
  const res = await fetch(url, { cache: "no-store" } as RequestInit);
  if (!res.ok) throw new Error(`Binance price fetch failed for ${priceSourceSymbol}`);
  const data = await res.json() as { price: string };
  const priceFloat = parseFloat(data.price);
  const price = BigInt(Math.round(priceFloat * Number(PRICE_PRECISION)));
  // 0.1% confidence interval
  const confidence = price / 1000n;
  const publishTime = BigInt(Math.floor(Date.now() / 1000));
  return { price, confidence, publishTime };
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
  console.log(`  Interval  : ${PUBLISH_INTERVAL_MS / 1000}s`);

  async function writePrice(oracleSymbol: string, price: bigint, confidence: bigint, publishTime: bigint) {
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
      return;
    }

    const prepared = sorobanRpc.assembleTransaction(tx, simResult).build();
    prepared.sign(publisherKp);

    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      process.stdout.write(` ✗ submit: ${send.errorResult?.toXDR("base64")?.slice(0, 60)}\n`);
      return;
    }

    // Poll for confirmation
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") {
        process.stdout.write(` ✓ ${send.hash.slice(0, 12)}\n`);
        return;
      }
      if (poll.status === "FAILED") {
        process.stdout.write(` ✗ tx failed\n`);
        return;
      }
    }
    process.stdout.write(` ? timeout\n`);
  }

  async function publishMarket(market: (typeof ORACLE_MARKETS)[number]) {
    try {
      const { price, confidence, publishTime } = await fetchBinancePrice(market.priceSourceSymbol);
      const priceHuman = Number(price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing ${market.oracleSymbol} $${priceHuman.toFixed(4)} at ${new Date().toISOString().slice(11, 19)}...`);
      await writePrice(market.oracleSymbol, price, confidence, publishTime);
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  // The settlement/collateral asset (USDC) needs a fresh on-chain price so the
  // vault can value collateral during account_health. It's a $1 stablecoin —
  // publish the peg every tick (tight confidence) so it never goes stale.
  async function publishUsdc() {
    try {
      const publishTime = BigInt(Math.floor(Date.now() / 1000));
      process.stdout.write(`\r  Publishing USDC $1.0000 (peg) at ${new Date().toISOString().slice(11, 19)}...`);
      await writePrice("USDC", PRICE_PRECISION, PRICE_PRECISION / 1000n, publishTime);
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  async function tick() {
    for (const market of ORACLE_MARKETS) {
      await publishMarket(market);
    }
    await publishUsdc();
  }

  // Run immediately then on interval
  await tick();
  setInterval(tick, PUBLISH_INTERVAL_MS);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch(console.error);
