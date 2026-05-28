import { Keypair, Account, Contract, TransactionBuilder, Address, xdr, rpc, scValToNative } from "@stellar/stellar-sdk";
import { CONTRACTS, ASSETS, NETWORK } from "@/lib/config";
const kp = Keypair.fromSecret(process.env.ORACLE_PUBLISHER_SECRET!);
const admin = kp.publicKey();
const server = new rpc.Server(NETWORK.rpcUrl);
const fakeAcct = new Account(Keypair.random().publicKey(), "100");
async function check(label: string, assetAddr: string) {
  const tx = new TransactionBuilder(fakeAcct, { fee: "200000", networkPassphrase: NETWORK.passphrase })
    .addOperation(new Contract(CONTRACTS.vault).call("balance_of", new Address(admin).toScVal(), new Address(assetAddr).toScVal()))
    .setTimeout(0).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) { console.log(label, "sim error"); return; }
  const val = scValToNative((sim as any).result?.retval);
  console.log(label, ":", (Number(val) / 1e7).toFixed(4));
}
check("USDC in vault", ASSETS.usdc).then(() => check("XLM  in vault", ASSETS.nativeXlm)).then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1); });
