#!/usr/bin/env tsx
/**
 * Creates a USDC trustline for the ORACLE_PUBLISHER_SECRET account.
 * Must be run BEFORE using the Circle testnet faucet.
 *
 * Usage: npx tsx --env-file=.env.local scripts/setup-usdc-trustline.ts
 */

import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
  Horizon,
} from "@stellar/stellar-sdk";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) { console.error("❌  ORACLE_PUBLISHER_SECRET not set"); process.exit(1); }

  const kp     = Keypair.fromSecret(secret);
  const server = new Horizon.Server("https://horizon-testnet.stellar.org");
  const account = await server.loadAccount(kp.publicKey());

  // Check if trustline already exists
  const existing = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER
  );
  if (existing) {
    console.log(`✓ USDC trustline already exists — balance: ${existing.balance}`);
    return;
  }

  const usdcAsset = new Asset("USDC", USDC_ISSUER);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(30)
    .build();

  tx.sign(kp);
  const result = await server.submitTransaction(tx);
  console.log("✓ USDC trustline created!  Hash:", result.hash);
  console.log("");
  console.log("Next step — get free testnet USDC:");
  console.log("  1. Go to  https://faucet.circle.com");
  console.log("  2. Select Stellar Testnet");
  console.log("  3. Paste : GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF");
  console.log("  4. Submit — Circle will send 10 USDC");
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
