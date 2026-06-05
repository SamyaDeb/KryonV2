#!/usr/bin/env tsx
/**
 * redeploy-core.ts
 *
 * Deploys fresh instances of the core perp contracts (vault, engine,
 * order-gateway) using the ORACLE_PUBLISHER_SECRET key as admin, wired
 * to the already-redeployed oracle adapter (CDC342E2...).
 *
 * All WASMs are already uploaded on testnet — we just instantiate new
 * contract instances and initialize them.
 *
 * After running, lib/config.ts is patched with the new addresses so
 * the frontend, oracle-keeper, state-indexer, and matcher all work.
 *
 * Usage:
 *   npx tsx scripts/redeploy-core.ts
 */

import {
  Keypair,
  Account,
  Address,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  hash,
  StrKey,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const RPC_URL   = "https://soroban-testnet.stellar.org";
const NETWORK   = "Test SDF Network ; September 2015";
const FEE       = "2000000"; // 0.2 XLM — higher for complex ops

// WASMs already on-chain from original deploy
const WASM: Record<string, string> = {
  vault:         "06c578a0f08aacfe5a1ee56614acbbb78da2ebd88d39030613f9b926b72e2783",
  engine:        "f6549f1931345be1bbeda9ba9de1cc1e57827676cdabad0040423e7541a8c785",
  orderGateway:  "a959b13019f15d2e0ae7b0e1126920e1b895c64e1de8647865ad1963eb42a5a5",
  risk:          "c0dc9f73b67588b55aa3aca4735775dc2fbfb29d7a3681f2634b8221522ef251",
};

// Existing contracts we keep (already controlled by our key or unchanged)
const ORACLE_ADAPTER = "CARSV4BT3II5QONUAOP4D363OUNTTSSZCXSKNNXKZCBJM7Z6UXSNZ3LP";
const USDC_CONTRACT  = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

// Market constants (from original deployment config)
const PRECISION = BigInt("1000000000000000000"); // 1e18

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// ── Deploy a contract from an existing WASM hash ──────────────────────────────

async function deployContract(
  server: sorobanRpc.Server,
  kp: Keypair,
  account: Account,
  wasmHash: string,
  label: string
): Promise<{ contractId: string; account: Account }> {
  const salt = crypto.randomBytes(32);

  const deployerScAddr = new Address(kp.publicKey()).toScAddress();
  const createArgs = new xdr.CreateContractArgs({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({ address: deployerScAddr, salt })
    ),
    executable: xdr.ContractExecutable.contractExecutableWasm(
      Buffer.from(wasmHash, "hex")
    ),
  });

  const deployOp = xdr.Operation.fromXDR(
    new xdr.Operation({
      sourceAccount: null,
      body: xdr.OperationBody.invokeHostFunction(
        new xdr.InvokeHostFunctionOp({
          hostFunction: xdr.HostFunction.hostFunctionTypeCreateContract(createArgs),
          auth: [],
        })
      ),
    }).toXDR()
  );

  // Compute contract ID
  const networkId   = hash(Buffer.from(NETWORK));
  const preimage    = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({ address: deployerScAddr, salt })
      ),
    })
  );
  const contractId = StrKey.encodeContract(hash(preimage.toXDR()));

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(deployOp)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`Deploy ${label} sim failed: ${(sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200)}`);
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  process.stdout.write(`  [${label}] deploying → ${contractId.slice(0, 10)}...`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`Deploy ${label} failed: ${send.errorResult?.toXDR("base64")}`);

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(` ✓\n`); break; }
    if (poll.status === "FAILED") throw new Error(`Deploy ${label} tx failed`);
    process.stdout.write(".");
  }

  const newAccount = await server.getAccount(kp.publicKey());
  return { contractId, account: newAccount };
}

// ── Call a contract function and wait for confirmation ────────────────────────

async function callContract(
  server: sorobanRpc.Server,
  kp: Keypair,
  account: Account,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string
): Promise<Account> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    throw new Error(`${label} sim failed: ${(sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error?.slice(0, 200)}`);
  }

  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);

  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(` ✓\n`); break; }
    if (poll.status === "FAILED") throw new Error(`${label} tx failed`);
    process.stdout.write(".");
  }

  return server.getAccount(kp.publicKey());
}

function addr(a: string): xdr.ScVal { return new Address(a).toScVal(); }
function u32(n: number):  xdr.ScVal { return nativeToScVal(n, { type: "u32" }); }
function u64(n: bigint):  xdr.ScVal { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function bool_(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET;
  if (!secret) { console.error("❌  ORACLE_PUBLISHER_SECRET not set"); process.exit(1); }

  const kp     = Keypair.fromSecret(secret);
  const admin  = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);

  console.log("═══════════════════════════════════════════════════════");
  console.log("  Kryon Core Contract Redeployment");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Admin    : ${admin}`);
  console.log(`  Oracle   : ${ORACLE_ADAPTER} (existing)`);
  console.log(`  USDC     : ${USDC_CONTRACT} (existing)`);
  console.log("");

  let account = await server.getAccount(admin);

  // ── Deploy contracts ─────────────────────────────────────────────────────

  console.log("Step 1 — Deploy contracts");
  let vaultId: string, engineId: string, gatewayId: string, riskId: string;

  ({ contractId: vaultId,   account } = await deployContract(server, kp, account, WASM.vault,        "vault"));
  ({ contractId: riskId,    account } = await deployContract(server, kp, account, WASM.risk,         "risk"));
  ({ contractId: engineId,  account } = await deployContract(server, kp, account, WASM.engine,       "engine"));
  ({ contractId: gatewayId, account } = await deployContract(server, kp, account, WASM.orderGateway, "order-gateway"));

  console.log("");
  console.log(`  vault        : ${vaultId}`);
  console.log(`  risk         : ${riskId}`);
  console.log(`  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}`);
  console.log("");

  // ── Initialize contracts ─────────────────────────────────────────────────
  // Signatures (from contracts source):
  //   vault.initialize(admin, oracle, engine)  — store engine for auth checks
  //   risk.initialize(admin)
  //   engine.initialize(admin, oracle, vault, settlement_asset)
  //   gateway.initialize(admin, engine)
  //
  // Circular dep: vault needs engine addr, engine needs vault addr.
  // Resolve: init vault with admin as placeholder, deploy engine, then vault.set_engine().

  console.log("Step 2 — Initialize contracts");

  // vault.initialize(admin, oracle, placeholder=admin)
  account = await callContract(server, kp, account, vaultId, "initialize",
    [addr(admin), addr(ORACLE_ADAPTER), addr(admin)], "vault.initialize");

  // risk.initialize(admin)
  account = await callContract(server, kp, account, riskId, "initialize",
    [addr(admin)], "risk.initialize");

  // engine.initialize(admin, oracle, vault, settlement_asset)
  account = await callContract(server, kp, account, engineId, "initialize",
    [addr(admin), addr(ORACLE_ADAPTER), addr(vaultId), addr(USDC_CONTRACT)], "engine.initialize");

  // gateway.initialize(admin, engine)
  account = await callContract(server, kp, account, gatewayId, "initialize",
    [addr(admin), addr(engineId)], "gateway.initialize");

  console.log("");

  // ── Wire up cross-references ─────────────────────────────────────────────

  console.log("Step 3 — Wire cross-references");

  // vault.set_engine(engine)  — replace placeholder with real engine
  account = await callContract(server, kp, account, vaultId, "set_engine",
    [addr(engineId)], "vault.set_engine");

  // engine.set_order_gateway(gateway)
  account = await callContract(server, kp, account, engineId, "set_order_gateway",
    [addr(gatewayId)], "engine.set_order_gateway");

  // vault.set_collateral(usdc, "USDC", haircut_bps=0, active=true)
  account = await callContract(server, kp, account, vaultId, "set_collateral",
    [addr(USDC_CONTRACT), xdr.ScVal.scvSymbol("USDC"), u32(0), xdr.ScVal.scvBool(true)], "vault.set_collateral(USDC)");

  // C2 liveness: set the settlement domain so the gateway can reconstruct the
  // canonical message and verify maker/taker signatures on-chain.
  // Domain = network passphrase bytes (prevents cross-network replay).
  const domainBytes = Buffer.from(NETWORK, "utf8");
  account = await callContract(server, kp, account, gatewayId, "set_domain",
    [xdr.ScVal.scvBytes(domainBytes)], "gateway.set_domain");

  console.log("");

  // ── Configure XLM-PERP market ────────────────────────────────────────────

  console.log("Step 4 — Configure XLM-PERP market");

  // MarketConfig (protocol-core, alphabetical field order):
  //   active, base_asset, initial_margin_bps, liquidation_fee_bps, maintenance_margin_bps,
  //   market_id, max_leverage_bps, max_open_interest, max_oracle_age_secs,
  //   max_oracle_confidence_bps, settlement_asset
  const coreMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("active"),                   val: xdr.ScVal.scvBool(true) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("base_asset"),               val: xdr.ScVal.scvSymbol("XLM") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("initial_margin_bps"),       val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("liquidation_fee_bps"),      val: u32(50) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("maintenance_margin_bps"),   val: u32(500) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market_id"),                val: u32(1) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_leverage_bps"),         val: u32(100000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_open_interest"),        val: i128(PRECISION * 1_000_000n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_age_secs"),      val: u64(120n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_confidence_bps"), val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("settlement_asset"),         val: addr(USDC_CONTRACT) }),
  ]);

  // EngineMarketConfig: { market: MarketConfig, max_execution_deviation_bps: u32 }
  const engineMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market"),                       val: coreMarketConfig }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_execution_deviation_bps"),  val: u32(500) }),
  ]);

  account = await callContract(server, kp, account, engineId, "set_market",
    [engineMarketConfig], "engine.set_market(XLM-PERP)");

  // vault also takes plain MarketConfig
  account = await callContract(server, kp, account, vaultId, "set_market_config",
    [coreMarketConfig], "vault.set_market_config(XLM-PERP)");

  console.log("");

  // ── Patch config files ────────────────────────────────────────────────────

  console.log("Step 5 — Patching config files");

  const configPath = path.resolve(__dirname, "../config/index.ts");
  let configSrc = fs.readFileSync(configPath, "utf8");

  const patches: [RegExp, string][] = [
    [/vault:\s*["'][^"']+["']/, `vault: "${vaultId}"`],
    [/engine:\s*["'][^"']+["']/, `engine: "${engineId}"`],
    [/orderGateway:\s*["'][^"']+["']/, `orderGateway: "${gatewayId}"`],
  ];

  for (const [regex, replacement] of patches) {
    if (regex.test(configSrc)) {
      configSrc = configSrc.replace(regex, replacement);
    }
  }
  fs.writeFileSync(configPath, configSrc);
  console.log("  ✓ lib/config.ts patched");

  // Patch state-indexer CONTRACTS
  const indexerPath = path.resolve(__dirname, "state-indexer.ts");
  let indexerSrc = fs.readFileSync(indexerPath, "utf8");
  indexerSrc = indexerSrc.replace(/engine:\s*["'][^"']+["']/, `engine:       "${engineId}"`);
  indexerSrc = indexerSrc.replace(/vault:\s*["'][^"']+["']/, `vault:        "${vaultId}"`);
  fs.writeFileSync(indexerPath, indexerSrc);
  console.log("  ✓ scripts/state-indexer.ts patched");

  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✓ Core redeployment complete");
  console.log("");
  console.log(`  vault        : ${vaultId}`);
  console.log(`  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}`);
  console.log(`  risk         : ${riskId}`);
  console.log(`  oracle       : ${ORACLE_ADAPTER} (unchanged)`);
  console.log("");
  console.log("  NOTE: Users must deposit USDC into the NEW vault address.");
  console.log("        Restart: npm run dev && npm run dev:indexer && npm run dev:oracle && npm run dev:matcher");
  console.log("═══════════════════════════════════════════════════════");
}

main().catch((e) => { console.error("❌ ", e.message); process.exit(1); });
