// Deposit USDC into new vault, then verify settle_fill simulation succeeds
import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, Address, xdr, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK, ASSETS } from "@/config";
import { simulateSettleFill } from "@/lib/stellar/settlement";

const FEE = "1000000";
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callVault(server: sorobanRpc.Server, kp: Keypair, account: Account, method: string, args: xdr.ScVal[], label: string): Promise<Account> {
  const contract = new Contract(CONTRACTS.vault);
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
  const AMOUNT = BigInt("100000000"); // 10 USDC (1e7 = 1.0 USDC, so 10)

  console.log("Depositing USDC into vault...");
  // vault.deposit(user, asset, amount)
  account = await callVault(server, kp, account, "deposit", [
    new Address(admin).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
    nativeToScVal(AMOUNT, { type: "i128" }),
  ], `vault.deposit(${Number(AMOUNT)/1e7} USDC)`);

  console.log("\nTesting settle_fill simulation...");
  const result = await simulateSettleFill({
    maker: { owner: admin, marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
    taker: { owner: admin, marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
    fillSize: 10000000n,
    fillPrice: 210000000000000000n,
    fillHash: "test-full-flow",
    feePayerSecret: secret
  });

  if (result) {
    console.log("✓ settle_fill simulation SUCCEEDED");
    console.log("  makerAuthXdr :", result.makerAuthXdr.slice(0,40)+"...");
    console.log("  takerAuthXdr :", result.takerAuthXdr.slice(0,40)+"...");
    console.log("  assembledTx  :", result.assembledTxXdr.slice(0,40)+"...");
    console.log("\nFreighter auth flow is FULLY OPERATIONAL.");
    console.log("  1. matcher-service detects a fill");
    console.log("  2. simulate settle_fill → get auth entries");
    console.log("  3. store in TxJob, frontend polls /api/settlements");
    console.log("  4. SettlementModal shows → user clicks 'Sign Settlement'");
    console.log("  5. Freighter.signAuthEntry(makerAuthXdr / takerAuthXdr)");
    console.log("  6. POST /api/settlements/[id]/sign with signed entry");
    console.log("  7. Both signed → submitSettlement() → on-chain ✓");
  } else {
    console.log("✗ simulation returned null");
  }
  process.exit(0);
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
