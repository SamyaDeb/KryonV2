#!/usr/bin/env tsx
/**
 * Oracle Keeper — writes live XLM/USD prices from Binance to the
 * perp-oracle-adapter contract on Stellar testnet.
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
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK = "Test SDF Network ; September 2015";
const ORACLE_ADAPTER = "CDC342E2GSLQKPHNWOWYUKNMSBES2OOTRHKA7YZO77SCZEN6XDQ334MD";
const PRICE_PRECISION = BigInt("1000000000000000000"); // 1e18
const PUBLISH_INTERVAL_MS = 8_000; // every 8s — oracle guard max_age is 60s
const BINANCE_URL = "https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT";

// ── Helpers ───────────────────────────────────────────────────────────────────

function toI128ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "i128" });
}

function toU64ScVal(n: bigint): xdr.ScVal {
  return nativeToScVal(n, { type: "u64" });
}

async function fetchBinancePrice(): Promise<{ price: bigint; confidence: bigint; publishTime: bigint }> {
  const res = await fetch(BINANCE_URL, { cache: "no-store" } as RequestInit);
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
  const server = new sorobanRpc.Server(RPC_URL);
  const contract = new Contract(ORACLE_ADAPTER);
  const assetArg = nativeToScVal("XLM", { type: "symbol" });
  const publisherArg = nativeToScVal(publisherAddress, { type: "address" });

  console.log(`✓ Oracle keeper starting`);
  console.log(`  Publisher : ${publisherAddress}`);
  console.log(`  Contract  : ${ORACLE_ADAPTER}`);
  console.log(`  Interval  : ${PUBLISH_INTERVAL_MS / 1000}s`);

  let seq = 1000;

  async function tick() {
    try {
      const { price, confidence, publishTime } = await fetchBinancePrice();
      const priceHuman = Number(price) / Number(PRICE_PRECISION);
      process.stdout.write(`\r  Publishing XLM $${priceHuman.toFixed(4)} at ${new Date().toISOString().slice(11, 19)}...`);

      const account = new Account(publisherAddress, (seq++).toString());

      // Fetch real sequence for submission
      const onChainAccount = await server.getAccount(publisherAddress);

      const tx = new TransactionBuilder(onChainAccount, { fee: "500000", networkPassphrase: NETWORK })
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
    } catch (e) {
      process.stdout.write(` ✗ ${(e as Error).message?.slice(0, 100)}\n`);
    }
  }

  // Run immediately then on interval
  await tick();
  setInterval(tick, PUBLISH_INTERVAL_MS);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

run().catch(console.error);
