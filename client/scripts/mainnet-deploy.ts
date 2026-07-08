#!/usr/bin/env tsx
/**
 * mainnet-deploy.ts — one-shot, resume-safe Kryon mainnet deployment.
 *
 * Mirrors the testnet-proven flows (redeploy-core.ts, redeploy-oracle.ts,
 * rewire-liquidation.ts) plus the 2026-07-07 testnet dress rehearsal of the
 * exact artifacts in kryon-protocol/target/wasm32v1-none/release/deploy/.
 *
 * Every step checkpoints to infra/deploy/mainnet-deployment.json; rerunning
 * skips completed steps, so a crash never repeats a paid upload.
 *
 * Refuses to run unless each local artifact's sha256 matches EXPECTED_SHA256
 * (the set that was simulated on mainnet and rehearsed on testnet).
 *
 * Usage:
 *   MAINNET_DEPLOYER_SECRET=S... npx tsx scripts/mainnet-deploy.ts [--dry-run]
 */

import {
  Keypair,
  Account,
  Address,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  nativeToScVal,
  xdr,
  rpc as sorobanRpc,
} from "@stellar/stellar-sdk";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";

const RPC_URL = process.env.MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com";
// Public mainnet RPCs are flaky; rotate through these on timeout.
const RPC_POOL = [
  RPC_URL,
  "https://soroban-rpc.mainnet.stellar.gateway.fm",
  "https://mainnet.sorobanrpc.com",
];
const NETWORK = "Public Global Stellar Network ; September 2015";
const FEE = "2000000"; // 0.2 XLM max inclusion for invokes

// Canonical mainnet assets (derived + verified live 2026-07-07)
const USDC_CONTRACT = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

const PROTO = path.resolve(__dirname, "../../kryon-protocol");
const ARTIFACTS = path.join(PROTO, "target/wasm32v1-none/release/deploy");
const STATE_PATH = path.join(PROTO, "infra/deploy/mainnet-deployment.json");
const SECRETS_PATH = path.join(PROTO, "infra/deploy/mainnet-secrets.env");

// sha256 of the artifacts that were mainnet-simulated (304.2 XLM total) and
// testnet-rehearsed 2026-07-07. Deployment aborts on any mismatch.
const EXPECTED_SHA256: Record<string, string> = {
  perp_vault:         "063b932fb6b953a685bcb66b189b2143eda715650979095e39eb36c92ec7eaa2",
  perp_engine:        "bc054afff1d44565a17381250e3a52127ee3d39b95c5eae582f43f0f6077e577",
  perp_order_gateway: "0ba8f9707e2e70b35267da7ab9718e4cae2c3ba2917e90aa625d413e02fe4d6d",
  perp_risk:          "87226639ea86545d54eaa2c81bf0658647434151ef2688179d76654307549f9d",
  perp_oracle_adapter:"887b08be75d275a9760e796f6e96bc297223d7a8018cedc70e0f46d9086ebae8",
  perp_insurance:     "26e0506ebf3e5954906ddd5ac80ed6f57c95d79480da56be9edc9a629ba79368",
  perp_liquidation:   "08168a26fa82d64ed906c4e6d839508f70b7ac32c02595cfe3a3e64946e53cdb",
  perp_governance:    "90f9b22631a09ec921847b3cfdf68a0734e4c7b9e7c1730f53bdf74515723220",
};

const PRECISION = BigInt("1000000000000000000");
const DEPOSIT_CAP_USDC = 5_000_000_000n; // 500 USDC (7dp) — staged-launch cap
const GOV_MIN_DELAY_SECS = 172_800n; // 48h

type State = {
  ops?: Record<string, { pub: string }>;
  wasm?: Record<string, string>;
  contracts?: Record<string, string>;
  steps?: Record<string, boolean>;
};

const DRY = process.argv.includes("--dry-run");

function loadState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); } catch { return {}; }
}
function saveState(s: State) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function addr(a: string): xdr.ScVal { return new Address(a).toScVal(); }
function u32(n: number): xdr.ScVal { return nativeToScVal(n, { type: "u32" }); }
function u64(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "u64" }); }
function i128(n: bigint): xdr.ScVal { return nativeToScVal(n, { type: "i128" }); }
function sym(s: string): xdr.ScVal { return xdr.ScVal.scvSymbol(s); }
function boolv(b: boolean): xdr.ScVal { return xdr.ScVal.scvBool(b); }

async function waitForSequenceStable(server: sorobanRpc.Server, publicKey: string) {
  let prev = "";
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const seq = (await server.getAccount(publicKey)).sequenceNumber();
    if (seq === prev) return;
    prev = seq;
  }
}

function cli(args: string[], label: string, timeoutMs = 300_000): string {
  if (DRY) {
    const redacted = args.map((a) => (/^S[A-Z2-7]{55}$/.test(a) ? "S…REDACTED" : a));
    console.log(`  [dry] stellar ${redacted.join(" ")}`);
    return "DRY";
  }
  const res = spawnSync("stellar", args, { encoding: "utf8", timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout.trim()) {
    throw new Error(`${label} failed:\n${res.stderr}`);
  }
  return res.stdout.trim().split("\n").pop()!.trim();
}

async function call(
  server: sorobanRpc.Server,
  kp: Keypair,
  contractId: string,
  method: string,
  args: xdr.ScVal[],
  label: string,
  allowFailCodes: number[] = []
): Promise<void> {
  process.stdout.write(`  [${label}]...`);
  if (DRY) { console.log(" (dry)"); return; }
  const contract = new Contract(contractId);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) { process.stdout.write(` retry ${attempt + 1}...`); await waitForSequenceStable(server, kp.publicKey()); }
    const account = await server.getAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK })
      .addOperation(contract.call(method, ...args))
      .setTimeout(120)
      .build();
    const sim = await server.simulateTransaction(tx);
    if (sorobanRpc.Api.isSimulationError(sim)) {
      const err = (sim as sorobanRpc.Api.SimulateTransactionErrorResponse).error ?? "";
      const already = allowFailCodes.some((c) => err.includes(`Error(Contract, #${c})`));
      if (already) { console.log(` skipped (already done: contract error tolerated)`); return; }
      throw new Error(`${label} sim failed: ${err.slice(0, 300)}`);
    }
    const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
    prepared.sign(kp);
    const send = await server.sendTransaction(prepared);
    if (send.status === "ERROR") {
      process.stdout.write(" submit ERROR");
      continue;
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const poll = await server.getTransaction(send.hash);
      if (poll.status === "SUCCESS") { console.log(" ✓"); return; }
      if (poll.status === "FAILED") throw new Error(`${label} FAILED on-chain: ${send.hash}`);
    }
  }
  throw new Error(`${label}: exhausted retries`);
}

async function main() {
  const secret = process.env.MAINNET_DEPLOYER_SECRET;
  if (!secret) { console.error("MAINNET_DEPLOYER_SECRET not set"); process.exit(1); }
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(RPC_URL);
  const state = loadState();
  state.ops ??= {}; state.wasm ??= {}; state.contracts ??= {}; state.steps ??= {};
  const done = (k: string) => !!state.steps![k];
  const mark = (k: string) => { state.steps![k] = true; saveState(state); };

  console.log("════════════════════════════════════════════════");
  console.log("  KRYON MAINNET DEPLOYMENT");
  console.log(`  deployer: ${admin}`);
  console.log(`  dry-run : ${DRY}`);
  console.log("════════════════════════════════════════════════\n");

  // ── Step 0: preflight ──────────────────────────────────────────────────────
  console.log("Step 0 — Preflight");
  for (const [name, want] of Object.entries(EXPECTED_SHA256)) {
    const got = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(ARTIFACTS, `${name}.wasm`)))
      .digest("hex");
    if (got !== want) throw new Error(`artifact hash mismatch for ${name}: ${got}`);
  }
  console.log("  ✓ all 8 artifact hashes match the rehearsed/simulated set");

  const acct = await server.getAccount(admin);
  const bal = await fetch(`https://horizon.stellar.org/accounts/${admin}`)
    .then((r) => r.json())
    .then((d: any) => parseFloat(d.balances.find((b: any) => b.asset_type === "native").balance));
  console.log(`  deployer balance: ${bal} XLM`);
  const uploadsRemaining = Object.keys(EXPECTED_SHA256).filter((n) => !state.wasm?.[n]).length;
  const needed = uploadsRemaining * 40 + 15; // ~40 XLM worst-case per upload + wiring buffer
  if (!DRY && bal < needed) throw new Error(`balance ${bal} < ${needed} XLM needed for remaining steps`);

  // ── Step 1: ops accounts ───────────────────────────────────────────────────
  console.log("\nStep 1 — Ops accounts (oracle, matcher, liquidator, guardian)");
  if (!done("ops_accounts")) {
    const roles = ["oracle-publisher", "matcher-operator", "liquidator", "guardian"] as const;
    const kps: Record<string, Keypair> = {};
    const lines: string[] = [];
    const account = await server.getAccount(admin);
    const txb = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK });
    for (const role of roles) {
      const k = Keypair.random();
      kps[role] = k;
      lines.push(`# ${role}\n${role.toUpperCase().replace(/-/g, "_")}_PUBLIC=${k.publicKey()}\n${role.toUpperCase().replace(/-/g, "_")}_SECRET=${k.secret()}`);
      txb.addOperation(Operation.createAccount({
        destination: k.publicKey(),
        startingBalance: role === "guardian" ? "2" : "3",
      }));
    }
    if (!DRY) {
      const tx = txb.setTimeout(120).build();
      tx.sign(kp);
      const send = await server.sendTransaction(tx);
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const poll = await server.getTransaction(send.hash);
        if (poll.status === "SUCCESS") break;
        if (poll.status === "FAILED") throw new Error("ops account creation failed");
      }
      fs.writeFileSync(SECRETS_PATH, lines.join("\n") + "\n", { mode: 0o600 });
      for (const role of roles) state.ops![role] = { pub: kps[role].publicKey() };
      mark("ops_accounts");
      console.log(`  ✓ 4 accounts created, secrets → ${SECRETS_PATH} (chmod 600)`);
    } else {
      console.log("  (dry) would create 4 accounts");
    }
  } else {
    console.log("  ✓ already done");
  }
  const OPS = state.ops!;

  // ── Step 2: upload WASMs (the expensive part, ~304 XLM) ───────────────────
  console.log("\nStep 2 — Upload WASMs");

  // A timed-out submit may still land on-chain; checking the code entry before
  // and after each attempt makes retries double-pay-proof.
  async function wasmOnChain(hashHex: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(hashHex, "hex") })
    );
    for (const rpcUrl of RPC_POOL) {
      try {
        const s = new sorobanRpc.Server(rpcUrl);
        const res = await s.getLedgerEntries(key);
        return res.entries.length > 0;
      } catch { /* try next rpc */ }
    }
    throw new Error("all RPCs failed for getLedgerEntries");
  }

  for (const name of Object.keys(EXPECTED_SHA256)) {
    const want = EXPECTED_SHA256[name];
    if (state.wasm![name]) { console.log(`  ✓ ${name} already uploaded: ${state.wasm![name]}`); continue; }
    if (!DRY && (await wasmOnChain(want))) {
      console.log(`  ✓ ${name} already on-chain (prior attempt landed): ${want}`);
      state.wasm![name] = want; saveState(state);
      continue;
    }
    let uploaded = false;
    for (let attempt = 1; attempt <= 3 && !uploaded; attempt++) {
      const rpcUrl = RPC_POOL[(attempt - 1) % RPC_POOL.length];
      process.stdout.write(`  uploading ${name} (attempt ${attempt}, ${new URL(rpcUrl).host})...`);
      try {
        // --fee covers inclusion + FULL resource fee (~63 XLM max per upload);
        // unused resource fee is refunded, so a high cap is safe.
        const h = cli([
          "contract", "upload",
          "--wasm", path.join(ARTIFACTS, `${name}.wasm`),
          "--source-account", secret,
          "--rpc-url", rpcUrl,
          "--network-passphrase", NETWORK,
          "--fee", "800000000",
          "--no-cache",
        ], `upload ${name}`, 480_000);
        console.log(` ✓ ${h}`);
        if (!DRY) {
          if (h !== want) throw new Error(`on-chain hash ${h} != expected for ${name}`);
          state.wasm![name] = h; saveState(state);
        }
        uploaded = true;
      } catch (e: any) {
        console.log(` ✗ ${String(e.message).split("\n").pop()}`);
        if (!DRY && (await wasmOnChain(want))) {
          console.log(`  ✓ ${name} landed despite the error`);
          state.wasm![name] = want; saveState(state);
          uploaded = true;
        } else if (attempt === 3) {
          throw new Error(`upload ${name}: exhausted retries`);
        }
      }
    }
  }

  // ── Step 3: deploy instances ───────────────────────────────────────────────
  console.log("\nStep 3 — Deploy instances");
  const order = ["perp_oracle_adapter", "perp_vault", "perp_risk", "perp_engine",
                 "perp_order_gateway", "perp_insurance", "perp_liquidation", "perp_governance"];

  // Deterministic salt per contract → deterministic instance id, so a retry
  // after an ambiguous timeout can detect a landed deploy instead of creating
  // a duplicate instance.
  const saltFor = (name: string) => crypto.createHash("sha256").update(`kryon-mainnet-v1:${name}`).digest();
  const predictedId = (name: string) => {
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(NETWORK, "utf8")),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: new Address(admin).toScAddress(),
            salt: saltFor(name),
          })
        ),
      })
    );
    return StrKey.encodeContract(hash(preimage.toXDR()));
  };
  async function instanceOnChain(cid: string): Promise<boolean> {
    const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({
      contract: new Address(cid).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }));
    for (const rpcUrl of RPC_POOL) {
      try {
        const res = await new sorobanRpc.Server(rpcUrl).getLedgerEntries(key);
        return res.entries.length > 0;
      } catch { /* next rpc */ }
    }
    throw new Error("all RPCs failed for instance check");
  }

  for (const name of order) {
    if (state.contracts![name]) { console.log(`  ✓ ${name}: ${state.contracts![name]}`); continue; }
    const expectId = predictedId(name);
    if (!DRY && (await instanceOnChain(expectId))) {
      console.log(`  ✓ ${name} already deployed (prior attempt landed): ${expectId}`);
      state.contracts![name] = expectId; saveState(state);
      continue;
    }
    let deployed = false;
    for (let attempt = 1; attempt <= 3 && !deployed; attempt++) {
      const rpcUrl = RPC_POOL[(attempt - 1) % RPC_POOL.length];
      process.stdout.write(`  deploying ${name} (attempt ${attempt}, ${new URL(rpcUrl).host})...`);
      try {
        const id = cli([
          "contract", "deploy",
          "--wasm-hash", EXPECTED_SHA256[name],
          "--salt", saltFor(name).toString("hex"),
          "--source-account", secret,
          "--rpc-url", rpcUrl,
          "--network-passphrase", NETWORK,
          "--fee", "50000000",
          "--no-cache",
        ], `deploy ${name}`, 480_000);
        console.log(` ✓ ${id}`);
        if (!DRY) {
          if (id !== expectId) throw new Error(`deployed id ${id} != predicted ${expectId}`);
          state.contracts![name] = id; saveState(state);
        }
        deployed = true;
      } catch (e: any) {
        console.log(` ✗ ${String(e.message).split("\n").pop()}`);
        if (!DRY && (await instanceOnChain(expectId))) {
          console.log(`  ✓ ${name} landed despite the error: ${expectId}`);
          state.contracts![name] = expectId; saveState(state);
          deployed = true;
        } else if (attempt === 3) {
          throw new Error(`deploy ${name}: exhausted retries`);
        }
      }
    }
  }
  const C = state.contracts!;
  const [ORCL, VAULT, RISK, ENGINE, GW, INS, LIQ, GOV] = order.map((n) => C[n] ?? "DRY");

  // ── Step 4: initialize (rehearsed order) ──────────────────────────────────
  console.log("\nStep 4 — Initialize");
  const initSteps: [string, string, string, xdr.ScVal[]][] = [
    ["init_oracle",   ORCL,  "initialize", [addr(admin)]],
    ["init_vault",    VAULT, "initialize", [addr(admin), addr(ORCL), addr(admin)]],
    ["init_risk",     RISK,  "initialize", [addr(admin)]],
    ["init_engine",   ENGINE,"initialize", [addr(admin), addr(ORCL), addr(VAULT), addr(USDC_CONTRACT)]],
    ["init_gateway",  GW,    "initialize", [addr(admin), addr(ENGINE)]],
    ["init_insurance",INS,   "initialize", [addr(admin), addr(LIQ)]],
    ["init_liquidation", LIQ,"initialize", [addr(admin), addr(ENGINE), addr(VAULT), addr(INS), addr(USDC_CONTRACT), u32(50)]],
    ["init_governance",GOV,  "initialize", [addr(admin), addr(OPS["guardian"]?.pub ?? admin), u64(GOV_MIN_DELAY_SECS)]],
  ];
  for (const [key, id, method, args] of initSteps) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key, [3]); // #3 AlreadyInitialized tolerated
    mark(key);
  }

  // ── Step 5: wire cross-references ─────────────────────────────────────────
  console.log("\nStep 5 — Wire");
  const wire: [string, string, string, xdr.ScVal[]][] = [
    ["wire_vault_engine",    VAULT,  "set_engine",        [addr(ENGINE)]],
    ["wire_engine_gateway",  ENGINE, "set_order_gateway", [addr(GW)]],
    ["wire_gw_operator",     GW,     "set_operator",      [addr(OPS["matcher-operator"]?.pub ?? admin)]],
    ["wire_gw_domain",       GW,     "set_domain",        [xdr.ScVal.scvBytes(Buffer.from(NETWORK, "utf8"))]],
    ["wire_vault_collateral",VAULT,  "set_collateral",    [addr(USDC_CONTRACT), sym("USDC"), u32(0), boolv(true)]],
    ["wire_engine_insurance",ENGINE, "set_insurance",     [addr(INS)]],
    ["wire_engine_liq",      ENGINE, "set_liquidation",   [addr(LIQ)]],
    ["wire_vault_insurance", VAULT,  "set_insurance",     [addr(INS)]],
    ["wire_vault_liq",       VAULT,  "set_liquidation",   [addr(LIQ)]],
    ["wire_ins_vault",       INS,    "set_vault",         [addr(VAULT)]],
  ];
  for (const [key, id, method, args] of wire) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key);
    mark(key);
  }

  // ── Step 6: oracle feed ────────────────────────────────────────────────────
  console.log("\nStep 6 — Oracle XLM feed");
  if (!done("oracle_feed")) {
    const guard = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("max_age_secs"),       val: u64(120n) }),
      new xdr.ScMapEntry({ key: sym("max_confidence_bps"), val: u32(1000) }),
    ]);
    await call(server, kp, ORCL, "set_feed", [
      sym("XLM"),
      addr(OPS["oracle-publisher"]?.pub ?? admin),
      xdr.ScVal.scvVec([sym("RedStone")]),
      guard,
      boolv(true),
    ], "oracle.set_feed(XLM)");
    mark("oracle_feed");
  } else console.log("  ✓ already done");

  // ── Step 7: market config ──────────────────────────────────────────────────
  console.log("\nStep 7 — XLM-PERP market");
  const coreMarketConfig = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym("active"),                    val: boolv(true) }),
    new xdr.ScMapEntry({ key: sym("base_asset"),                val: sym("XLM") }),
    new xdr.ScMapEntry({ key: sym("initial_margin_bps"),        val: u32(1000) }),
    new xdr.ScMapEntry({ key: sym("liquidation_fee_bps"),       val: u32(50) }),
    new xdr.ScMapEntry({ key: sym("maintenance_margin_bps"),    val: u32(500) }),
    new xdr.ScMapEntry({ key: sym("market_id"),                 val: u32(1) }),
    new xdr.ScMapEntry({ key: sym("max_leverage_bps"),          val: u32(100000) }),
    new xdr.ScMapEntry({ key: sym("max_open_interest"),         val: i128(PRECISION * 100_000n) }),
    new xdr.ScMapEntry({ key: sym("max_oracle_age_secs"),       val: u64(120n) }),
    new xdr.ScMapEntry({ key: sym("max_oracle_confidence_bps"), val: u32(1000) }),
    new xdr.ScMapEntry({ key: sym("settlement_asset"),          val: addr(USDC_CONTRACT) }),
  ]);
  if (!done("market_engine")) {
    const engineMarketConfig = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: sym("market"),                      val: coreMarketConfig }),
      new xdr.ScMapEntry({ key: sym("max_execution_deviation_bps"), val: u32(1000) }),
    ]);
    await call(server, kp, ENGINE, "set_market", [engineMarketConfig], "engine.set_market");
    mark("market_engine");
  } else console.log("  ✓ engine market already set");
  if (!done("market_vault")) {
    await call(server, kp, VAULT, "set_market_config", [coreMarketConfig], "vault.set_market_config");
    mark("market_vault");
  } else console.log("  ✓ vault market already set");

  // ── Step 8: guardian + deposit caps (guarded-beta posture) ────────────────
  console.log("\nStep 8 — Guardian + deposit caps");
  const guardianPub = OPS["guardian"]?.pub ?? admin;
  const g: [string, string, string, xdr.ScVal[]][] = [
    ["guardian_vault", VAULT, "set_guardian",    [addr(guardianPub)]],
    ["guardian_gw",    GW,    "set_guardian",    [addr(guardianPub)]],
    ["cap_usdc",       VAULT, "set_deposit_cap", [addr(USDC_CONTRACT), i128(DEPOSIT_CAP_USDC)]],
  ];
  for (const [key, id, method, args] of g) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, method, args, key);
    mark(key);
  }

  // ── Step 9: instance TTL keepalive ─────────────────────────────────────────
  console.log("\nStep 9 — Extend instance TTLs (30d, contract-capped)");
  const ttlTargets: [string, string][] = [
    ["ttl_oracle", ORCL], ["ttl_vault", VAULT], ["ttl_engine", ENGINE], ["ttl_gw", GW],
  ];
  for (const [key, id] of ttlTargets) {
    if (done(key)) { console.log(`  ✓ ${key} already done`); continue; }
    await call(server, kp, id, "extend_instance_ttl", [], key);
    mark(key);
  }

  // ── Step 10: seed off-chain Market row(s) ───────────────────────────────────
  // On-chain config (Step 7) has no bearing on the Next.js app's Postgres
  // Market table — a separate, easy-to-forget piece of state that the matcher
  // and /api/markets/[id] both depend on. Missed entirely on the first mainnet
  // deploy (2026-07-08): a brand-new database gets its schema from `prisma
  // migrate deploy` but no initial rows, so every resting limit order sat
  // unmatched forever with the matcher's oracle-band filter failing closed.
  // Guarded (not required) because this script's primary job is on-chain and
  // may run in a context without DATABASE_URL configured — skip with a loud
  // reminder rather than failing the whole deploy over it.
  console.log("\nStep 10 — Seed off-chain Market DB row(s)");
  if (done("seed_markets")) {
    console.log("  ✓ seed_markets already done");
  } else if (!process.env.DATABASE_URL) {
    console.log("  ⚠ DATABASE_URL not set — skipped. Run `npm run db:seed-markets` once it's configured.");
  } else {
    const { neon } = await import("@neondatabase/serverless");
    const { seedMarkets } = await import("./seed-markets");
    const sql = neon(process.env.DATABASE_URL);
    const results = await seedMarkets(sql as never);
    for (const r of results) {
      console.log(`  ${r.inserted ? "✓ seeded" : "· already present"}  market ${r.id} (${r.symbol})`);
    }
    mark("seed_markets");
  }

  // ── Manifest ───────────────────────────────────────────────────────────────
  console.log("\n════════════════ DEPLOYED ════════════════");
  for (const name of order) console.log(`  ${name.padEnd(20)} ${C[name]}`);
  console.log(`  usdc (SAC)          ${USDC_CONTRACT}`);
  console.log(`\nState: ${STATE_PATH}\nSecrets: ${SECRETS_PATH}`);
  console.log("Next: seed insurance (swap XLM→USDC), queue governance admin transfer, cut services over.");
}

main().catch((e) => { console.error("\n❌ ", e.message ?? e); process.exit(1); });
