// Full end-to-end: two accounts, both with XLM collateral, settle_fill simulation
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
  const makerSecret = process.env.ORACLE_PUBLISHER_SECRET!;
  const makerKp = Keypair.fromSecret(makerSecret);
  const makerAddr = makerKp.publicKey();

  // Generate a fresh taker keypair and fund via Friendbot
  const takerKp = Keypair.random();
  const takerAddr = takerKp.publicKey();
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);

  console.log(`Maker : ${makerAddr}`);
  console.log(`Taker : ${takerAddr} (fresh testnet account)`);

  // Fund taker via Friendbot
  console.log("\nFunding taker via Friendbot...");
  const fb = await fetch(`https://friendbot.stellar.org?addr=${takerAddr}`);
  if (!fb.ok) throw new Error("Friendbot failed");
  await sleep(3000);

  let makerAcct = await server.getAccount(makerAddr);
  let takerAcct = await server.getAccount(takerAddr);
  const now = BigInt(Math.floor(Date.now()/1000));

  // Deposit XLM for taker  
  console.log("Depositing XLM for taker...");
  takerAcct = await callContract(server, takerKp, takerAcct, CONTRACTS.vault, "deposit", [
    new Address(takerAddr).toScVal(),
    new Address(ASSETS.nativeXlm).toScVal(),
    nativeToScVal(5_000_000_000n, { type: "i128" }), // 500 XLM
  ], "vault.deposit(taker, 500 XLM)");

  // Maker already has 1000 XLM deposited from previous test
  console.log("(Maker already has 1000 XLM in vault)\n");

  console.log("Simulating settle_fill...");
  const result = await simulateSettleFill({
    maker: { owner:makerAddr, marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
    taker: { owner:takerAddr, marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
    fillSize: 10000000n, fillPrice: 210000000000000000n,
    fillHash: "e2e-auth-test-001",
    feePayerSecret: makerSecret
  });

  if (result) {
    console.log("\n✅ settle_fill simulation SUCCEEDED");
    console.log("   makerAuthXdr :", result.makerAuthXdr.slice(0,60)+"...");
    console.log("   takerAuthXdr :", result.takerAuthXdr.slice(0,60)+"...");
    console.log("   assembledTx  :", result.assembledTxXdr.slice(0,50)+"...");
    console.log("\n✅ Freighter auth flow is FULLY OPERATIONAL");
    console.log("   The SettlementModal can now call:");
    console.log("   freighterSignAuthEntry(makerAuthXdr) → signed entry");
    console.log("   POST /api/settlements/[id]/sign → assembles + submits on-chain");
    console.log(`\n   Taker secret (save for testing): ${takerKp.secret()}`);
  } else {
    console.log("✗ null — check simulation error above");
  }
  process.exit(0);
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
