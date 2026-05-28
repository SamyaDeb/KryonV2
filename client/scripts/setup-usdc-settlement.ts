#!/usr/bin/env tsx
/**
 * Deploys a fresh engine + order-gateway with USDC as settlement asset,
 * wired to our vault (CAZV547Z) and oracle (CDC342E2).
 * Also writes USDC oracle feed ($1.00) so health checks pass.
 * Patches lib/config.ts with new addresses.
 */
import {
  Keypair, Account, Address, Contract, TransactionBuilder,
  nativeToScVal, xdr, hash, StrKey, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const RPC_URL  = "https://soroban-testnet.stellar.org";
const NETWORK  = "Test SDF Network ; September 2015";
const FEE      = "2000000";
const PRECISION = BigInt("1000000000000000000"); // 1e18

const WASM = {
  engine:       "f6549f1931345be1bbeda9ba9de1cc1e57827676cdabad0040423e7541a8c785",
  orderGateway: "a959b13019f15d2e0ae7b0e1126920e1b895c64e1de8647865ad1963eb42a5a5",
};

const ORACLE  = "CDC342E2GSLQKPHNWOWYUKNMSBES2OOTRHKA7YZO77SCZEN6XDQ334MD";
const VAULT   = "CAZV547ZY7S5IGGMYHDQWYM2TWAZ4MEJ6FJHWIJM7VF6GGXU3EUZ5ZOS";
const USDC    = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function deploy(server: sorobanRpc.Server, kp: Keypair, account: Account, wasmHash: string, label: string): Promise<{ contractId: string; account: Account }> {
  const salt = crypto.randomBytes(32);
  const scAddr = new Address(kp.publicKey()).toScAddress();
  const createArgs = new xdr.CreateContractArgs({
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: scAddr, salt })),
    executable: xdr.ContractExecutable.contractExecutableWasm(Buffer.from(wasmHash, "hex")),
  });
  const op = xdr.Operation.fromXDR(new xdr.Operation({ sourceAccount: null, body: xdr.OperationBody.invokeHostFunction(new xdr.InvokeHostFunctionOp({ hostFunction: xdr.HostFunction.hostFunctionTypeCreateContract(createArgs), auth: [] })) }).toXDR());
  const networkId = hash(Buffer.from(NETWORK));
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId, contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: scAddr, salt })) }));
  const contractId = StrKey.encodeContract(hash(preimage.toXDR()));
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK }).addOperation(op).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`deploy ${label}: ${(sim as any).error?.slice(0,200)}`);
  const prep = sorobanRpc.assembleTransaction(tx, sim).build(); prep.sign(kp);
  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prep);
  if (send.status === "ERROR") throw new Error(`deploy ${label} submit failed`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = await server.getTransaction(send.hash);
    if (p.status === "SUCCESS") { process.stdout.write(" ✓\n"); return { contractId, account: await server.getAccount(kp.publicKey()) }; }
    if (p.status === "FAILED") throw new Error(`deploy ${label} failed`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`deploy ${label} timeout`);
}

async function call(server: sorobanRpc.Server, kp: Keypair, account: Account, contractId: string, method: string, args: xdr.ScVal[], label: string): Promise<Account> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK }).addOperation(contract.call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${(sim as any).error?.slice(0,300)}`);
  const prep = sorobanRpc.assembleTransaction(tx, sim).build(); prep.sign(kp);
  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prep);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = await server.getTransaction(send.hash);
    if (p.status === "SUCCESS") { process.stdout.write(" ✓\n"); return server.getAccount(kp.publicKey()); }
    if (p.status === "FAILED") throw new Error(`${label} failed`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`${label} timeout`);
}

function addr(a: string) { return new Address(a).toScVal(); }
function u32(n: number)  { return nativeToScVal(n, { type: "u32" }); }
function u64(n: bigint)  { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET!;
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);
  let account = await server.getAccount(admin);
  const now = BigInt(Math.floor(Date.now() / 1000));

  console.log("═══════════════════════════════════════════════════");
  console.log("  USDC Settlement Setup");
  console.log("═══════════════════════════════════════════════════");
  console.log(`  Admin  : ${admin}`);
  console.log(`  Oracle : ${ORACLE}`);
  console.log(`  Vault  : ${VAULT}`);
  console.log(`  USDC   : ${USDC}`);
  console.log("");

  // Step 1 — ensure USDC oracle feed is fresh (write $1.00)
  console.log("Step 1 — Ensure USDC oracle feed is live ($1.00)");
  const PRICE_1 = BigInt("1000000000000000000");
  const redStone = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]);
  const guard24h = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"),       val: u64(86400n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: u32(500) }),
  ]);
  // set_feed first (idempotent — fine to call again)
  account = await call(server, kp, account, ORACLE, "set_feed", [
    xdr.ScVal.scvSymbol("USDC"), addr(admin), redStone, guard24h, xdr.ScVal.scvBool(true)
  ], "oracle.set_feed(USDC)");
  account = await call(server, kp, account, ORACLE, "write_price", [
    xdr.ScVal.scvSymbol("USDC"), addr(admin),
    i128(PRICE_1), i128(PRICE_1 / 200n), u64(now),
  ], "oracle.write_price(USDC=$1.00)");
  console.log("");

  // Step 2 — also ensure USDC is accepted as collateral in vault
  console.log("Step 2 — Register USDC as vault collateral");
  account = await call(server, kp, account, VAULT, "set_collateral", [
    addr(USDC), xdr.ScVal.scvSymbol("USDC"), u32(0), xdr.ScVal.scvBool(true)
  ], "vault.set_collateral(USDC)");
  console.log("");

  // Step 3 — Deploy engine + gateway with USDC as settlement asset
  console.log("Step 3 — Deploy engine + order-gateway (USDC settlement)");
  let engineId: string, gatewayId: string;
  ({ contractId: engineId,  account } = await deploy(server, kp, account, WASM.engine,       "engine"));
  ({ contractId: gatewayId, account } = await deploy(server, kp, account, WASM.orderGateway, "order-gateway"));
  console.log(`\n  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}\n`);

  // Step 4 — Initialize
  console.log("Step 4 — Initialize contracts");
  account = await call(server, kp, account, engineId,  "initialize", [addr(admin), addr(ORACLE), addr(VAULT), addr(USDC)], "engine.initialize(USDC)");
  account = await call(server, kp, account, gatewayId, "initialize", [addr(admin), addr(engineId)], "gateway.initialize");
  account = await call(server, kp, account, VAULT,     "set_engine",          [addr(engineId)],   "vault.set_engine");
  account = await call(server, kp, account, engineId,  "set_order_gateway",   [addr(gatewayId)],  "engine.set_order_gateway");
  console.log("");

  // Step 5 — Market config (USDC settlement)
  console.log("Step 5 — Configure XLM-PERP market");
  const coreMarket = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("active"),                    val: xdr.ScVal.scvBool(true) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("base_asset"),                val: xdr.ScVal.scvSymbol("XLM") }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("initial_margin_bps"),        val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("liquidation_fee_bps"),       val: u32(50) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("maintenance_margin_bps"),    val: u32(500) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market_id"),                 val: u32(1) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_leverage_bps"),          val: u32(100000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_open_interest"),         val: i128(PRECISION * 1_000_000n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_age_secs"),       val: u64(120n) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_oracle_confidence_bps"), val: u32(1000) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("settlement_asset"),          val: addr(USDC) }),
  ]);
  const engineMarket = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("market"),                       val: coreMarket }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_execution_deviation_bps"),  val: u32(500) }),
  ]);
  account = await call(server, kp, account, engineId, "set_market",      [engineMarket], "engine.set_market");
  account = await call(server, kp, account, VAULT,    "set_market_config", [coreMarket], "vault.set_market_config");
  console.log("");

  // Step 6 — Patch config.ts
  console.log("Step 6 — Patching config files");
  const configPath = path.resolve(__dirname, "../lib/config.ts");
  let src = fs.readFileSync(configPath, "utf8");
  src = src.replace(/engine:\s*["'][^"']+["']/,      `engine: "${engineId}"`);
  src = src.replace(/orderGateway:\s*["'][^"']+["']/, `orderGateway: "${gatewayId}"`);
  fs.writeFileSync(configPath, src);

  const indexerPath = path.resolve(__dirname, "state-indexer.ts");
  let idx = fs.readFileSync(indexerPath, "utf8");
  idx = idx.replace(/engine:\s*["'][^"']+["']/, `engine:       "${engineId}"`);
  fs.writeFileSync(indexerPath, idx);

  console.log("  ✓ lib/config.ts patched");
  console.log("  ✓ scripts/state-indexer.ts patched");
  console.log("");

  console.log("═══════════════════════════════════════════════════");
  console.log("  ✓ USDC settlement setup complete!");
  console.log("");
  console.log(`  engine       : ${engineId}`);
  console.log(`  order-gateway: ${gatewayId}`);
  console.log(`  vault        : ${VAULT} (unchanged)`);
  console.log(`  oracle       : ${ORACLE} (unchanged)`);
  console.log("");
  console.log("  To use the DEX:");
  console.log("  1. Deposit USDC via the frontend DepositWithdraw dialog");
  console.log("  2. Place orders — matcher will fill them");
  console.log("  3. SettlementModal will appear for on-chain settlement");
  console.log("═══════════════════════════════════════════════════");
}

main().catch(e => { console.error("❌", e.message); process.exit(1); });
