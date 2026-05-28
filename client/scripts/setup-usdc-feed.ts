import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, xdr, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "@/lib/config";

const FEE = "1000000";
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callOracle(server: sorobanRpc.Server, kp: Keypair, account: Account, method: string, args: xdr.ScVal[], label: string): Promise<Account> {
  const contract = new Contract(CONTRACTS.oracleAdapter);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args)).setTimeout(90).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${label} sim failed: ${(sim as any).error?.slice(0,200)}`);
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);
  for (let i = 0; i < 60; i++) {  // 60s poll
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(" ✓\n"); return server.getAccount(kp.publicKey()); }
    if (poll.status === "FAILED") throw new Error(`${label} tx failed on-chain`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`${label} confirmation timeout after 60s — hash: ${send.hash}`);
}

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET!;
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  let account = await server.getAccount(admin);
  const now = BigInt(Math.floor(Date.now() / 1000));
  const PRICE_1 = BigInt("1000000000000000000"); // $1.00

  console.log("Setting up USDC oracle feed...");

  const redStone = xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("RedStone")]);
  const guard = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_age_secs"),        val: nativeToScVal(86400n, { type: "u64" }) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("max_confidence_bps"), val: nativeToScVal(500, { type: "u32" }) }),
  ]);

  account = await callOracle(server, kp, account, "set_feed", [
    xdr.ScVal.scvSymbol("USDC"),
    nativeToScVal(admin, { type: "address" }),
    redStone, guard,
    xdr.ScVal.scvBool(true)
  ], "set_feed(USDC)");

  account = await callOracle(server, kp, account, "write_price", [
    xdr.ScVal.scvSymbol("USDC"),
    nativeToScVal(admin, { type: "address" }),
    nativeToScVal(PRICE_1,        { type: "i128" }),
    nativeToScVal(PRICE_1 / 200n, { type: "i128" }),  // 0.5% confidence
    nativeToScVal(now,            { type: "u64" }),
  ], "write_price(USDC, $1.00)");

  console.log("✓ USDC oracle feed ready — $1.00 written");
  process.exit(0);
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
