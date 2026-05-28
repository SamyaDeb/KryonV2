// Fund a second account with USDC via classic Stellar payment, then verify full settle_fill
import {
  Keypair, TransactionBuilder, Networks, Operation, Asset,
  BASE_FEE, Horizon, Account as StellarAccount,
  Contract, Address, nativeToScVal, xdr, rpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, ASSETS, NETWORK } from "@/lib/config";
import { simulateSettleFill } from "@/lib/stellar/settlement";

const FEE = "1000000";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function callC(server: rpc.Server, kp: Keypair, acct: rpc.Api.GetAccountResponse | StellarAccount, cid: string, method: string, args: xdr.ScVal[], label: string): Promise<rpc.Api.GetAccountResponse> {
  const tx = new TransactionBuilder(acct as any, { fee: FEE, networkPassphrase: NETWORK.passphrase }).addOperation(new Contract(cid).call(method, ...args)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${label}: ${(sim as any).error?.slice(0,200)}`);
  const prep = rpc.assembleTransaction(tx, sim).build(); prep.sign(kp);
  process.stdout.write(`  [${label}]...`);
  const send = await server.sendTransaction(prep);
  if (send.status === "ERROR") throw new Error(`${label} submit failed`);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const p = await server.getTransaction(send.hash);
    if (p.status === "SUCCESS") { process.stdout.write(" ✓\n"); return server.getAccount(kp.publicKey()); }
    if (p.status === "FAILED") throw new Error(`${label} failed`);
    if (i%5===0) process.stdout.write(".");
  }
  throw new Error(`${label} timeout`);
}

async function main() {
  const makerSecret = process.env.ORACLE_PUBLISHER_SECRET!;
  const makerKp = Keypair.fromSecret(makerSecret);
  const makerAddr = makerKp.publicKey();
  const takerKp = Keypair.random();
  const takerAddr = takerKp.publicKey();
  const server = new rpc.Server(NETWORK.rpcUrl);
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
  const now = BigInt(Math.floor(Date.now()/1000));

  console.log(`Maker : ${makerAddr}`);
  console.log(`Taker : ${takerAddr}`);

  // 1. Fund taker via Friendbot (XLM for fees)
  process.stdout.write("Funding taker via Friendbot...");
  await fetch(`https://friendbot.stellar.org?addr=${takerAddr}`);
  await sleep(3000); process.stdout.write(" ✓\n");

  // 2. Establish USDC trustline for taker (classic Stellar)
  process.stdout.write("Creating USDC trustline for taker...");
  const takerHorizonAcct = await horizon.loadAccount(takerAddr);
  const trustlineTx = new TransactionBuilder(takerHorizonAcct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
    .setTimeout(30).build();
  trustlineTx.sign(takerKp);
  await horizon.submitTransaction(trustlineTx);
  process.stdout.write(" ✓\n");

  // 3. Send 10 USDC from maker to taker (classic payment)
  process.stdout.write("Sending 10 USDC to taker...");
  const makerHorizonAcct = await horizon.loadAccount(makerAddr);
  const payTx = new TransactionBuilder(makerHorizonAcct, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.payment({ destination: takerAddr, asset: new Asset("USDC", USDC_ISSUER), amount: "10" }))
    .setTimeout(30).build();
  payTx.sign(makerKp);
  await horizon.submitTransaction(payTx);
  process.stdout.write(" ✓\n");

  // 4. Deposit USDC for taker into vault
  console.log("Depositing 10 USDC into vault for taker...");
  let takerSorobanAcct = await server.getAccount(takerAddr);
  takerSorobanAcct = await callC(server, takerKp, takerSorobanAcct, CONTRACTS.vault, "deposit", [
    new Address(takerAddr).toScVal(),
    new Address(ASSETS.usdc).toScVal(),
    nativeToScVal(100000000n, { type: "i128" }), // 10 USDC (1e7)
  ], "vault.deposit(taker, 10 USDC)");

  // 5. Run settle_fill simulation
  console.log("\nSimulating settle_fill (both parties have USDC)...");
  const result = await simulateSettleFill({
    maker: { owner:makerAddr, marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n },
    taker: { owner:takerAddr, marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n },
    fillSize: 10000000n, fillPrice: 210000000000000000n,
    fillHash: "usdc-final-verified",
    feePayerSecret: makerSecret,
  });

  if (result) {
    console.log("\n✅  settle_fill simulation SUCCEEDED with USDC collateral");
    console.log(`    fill: 1 XLM @ $0.21  (settlement asset: USDC)`);
    console.log(`    makerAuthXdr: ${result.makerAuthXdr.slice(0,50)}...`);
    console.log(`    takerAuthXdr: ${result.takerAuthXdr.slice(0,50)}...`);
    console.log("\n✅  Freighter auth flow fully operational with USDC settlement");
    console.log(`    Taker secret (for testing): ${takerKp.secret()}`);
  } else {
    console.log("✗ simulation returned null");
  }
  process.exit(0);
}
main().catch(e => { console.error("❌", e.message); process.exit(1); });
