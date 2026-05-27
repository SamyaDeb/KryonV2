import { loadEnv, requiredEnv } from "./env.mjs";

loadEnv();

const rpcUrl = requiredEnv("STELLAR_RPC_URL");
const passphrase = requiredEnv("STELLAR_NETWORK_PASSPHRASE");

if (!passphrase.includes("Test SDF Network")) {
  throw new Error("Refusing testnet preflight with a non-testnet passphrase");
}

const response = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: "krypton-e2e-latest-ledger",
    method: "getLatestLedger",
  }),
});

if (!response.ok) {
  throw new Error(`Stellar RPC returned HTTP ${response.status}`);
}

const body = await response.json();
if (body.error) {
  throw new Error(`Stellar RPC error: ${JSON.stringify(body.error)}`);
}

const ledger = body.result?.sequence;
if (!Number.isInteger(ledger) || ledger <= 0) {
  throw new Error(`Invalid latest ledger response: ${JSON.stringify(body)}`);
}

console.log(`testnet-preflight ok: latest ledger ${ledger}`);
