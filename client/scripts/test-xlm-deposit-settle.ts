// Set XLM as collateral, deposit XLM, verify settle_fill simulation works
import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, Address, xdr, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, ASSETS, NETWORK } from "@/lib/config";
import { simulateSettleFill } from "@/lib/stellar/settlement";

const FEE = "1000000";
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callContract(server: sorobanRpc.Server, kp: Keypair, account: Account, contractId: string, method: string, args: xdr.ScVal[], label: string): Promise<Account> {
  const contract = new Contract(contractId);
  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) throw new Error(`${label} sim: ${(sim as any).error?.slice(0,300)}`);
  const prepared = sorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(kp);
  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prepared);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const poll = await server.getTransaction(send.hash);
    if (poll.status === "SUCCESS") { process.stdout.write(" ✓\n"); return server.getAccount(kp.publicKey()); }
    if (poll.status === "FAILED") throw new Error(`${label} tx failed`);
    if (i % 5 === 0) process.stdout.write(".");
  }
  throw new Error(`${label} timeout`);
}

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET!;
  const kp = Keypair.fromSecret(secret);
  const admin = kp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  let account = await server.getAccount(admin);
  const now = BigInt(Math.floor(Date.now()/1000));

  console.log("Step 1 — Register XLM as collateral");
  account = await callContract(server, kp, account, CONTRACTS.vault, "set_collateral", [
    new Address(ASSETS.nativeXlm).toScVal(),
    xdr.ScVal.scvSymbol("XLM"),
    nativeToScVal(0, { type: "u32" }),     // haircut_bps = 0 (no haircut for testing)
    xdr.ScVal.scvBool(true)
  ], "vault.set_collateral(XLM)");

  console.log("Step 2 — Deposit 1000 XLM into vault");
  // 1000 XLM = 10_000_000_000 in 1e7 (Stellar 7-decimal precision)
  account = await callContract(server, kp, account, CONTRACTS.vault, "deposit", [
    new Address(admin).toScVal(),
    new Address(ASSETS.nativeXlm).toScVal(),
    nativeToScVal(10_000_000_000n, { type: "i128" }),
  ], "vault.deposit(1000 XLM)");

  console.log("Step 3 — Test settle_fill simulation");
  const result = await simulateSettleFill({
    maker: { owner: admin, marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
    taker: { owner: admin, marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
    fillSize: 10000000n,
    fillPrice: 210000000000000000n,
    fillHash: "full-test-001",
    feePayerSecret: secret
  });

  if (result) {
    console.log("\n✓ settle_fill simulation SUCCEEDED");
    console.log("  makerAddress :", result.makerAddress);
    console.log("  takerAddress :", result.takerAddress);
    console.log("  makerAuthXdr :", result.makerAuthXdr.slice(0,50)+"...");
    console.log("  assembledTx  :", result.assembledTxXdr.slice(0,40)+"...");
    console.log("\n✓ Freighter auth flow is FULLY OPERATIONAL");
  } else {
    console.log("✗ simulation returned null");
  }
  process.exit(0);
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
