import {
  Keypair, Account, Contract, TransactionBuilder, Address,
  nativeToScVal, xdr, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, NETWORK } from "@/config";

const FEE = "2000000";
const now = BigInt(Math.floor(Date.now()/1000));

function mapEntry(k: string, v: xdr.ScVal) { return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }
function u64(n: bigint) { return nativeToScVal(n, { type: "u64" }); }
function u32(n: number) { return nativeToScVal(n, { type: "u32" }); }
function addrVal(a: string) { return new Address(a).toScVal(); }

function orderScVal(o: any) {
  return xdr.ScVal.scvMap([
    mapEntry("expiry_ts",   u64(o.expiryTs)),
    mapEntry("is_long",     xdr.ScVal.scvBool(o.isLong)),
    mapEntry("limit_price", i128(o.limitPrice)),
    mapEntry("market_id",   u32(o.marketId)),
    mapEntry("nonce",       u64(o.nonce)),
    mapEntry("owner",       addrVal(o.owner)),
    mapEntry("reduce_only", xdr.ScVal.scvBool(o.reduceOnly)),
    mapEntry("size",        i128(o.size)),
  ]);
}

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET!;
  const kp = Keypair.fromSecret(secret);
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const account = await server.getAccount(kp.publicKey());
  const contract = new Contract(CONTRACTS.orderGateway);

  const fillArg = xdr.ScVal.scvMap([
    mapEntry("fill_price", i128(210000000000000000n)),
    mapEntry("fill_size",  i128(100000000n)),
    mapEntry("maker", orderScVal({ owner:"GA3SSO6D4YL5W6NDCO5V72BN5PHXC3SOBRAFMDSMUOM7OTXY2S6UAUHF", marketId:1, isLong:true, size:100000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n })),
    mapEntry("taker", orderScVal({ owner:"GBTL7SKBHYAROO5CYGTQ4ITTEPTUUPIXDFDYZNDNAYQJ4J5XENX4TGDI", marketId:1, isLong:false, size:100000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n })),
  ]);

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call("settle_fill", fillArg))
    .setTimeout(60).build();

  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    // Print full error log
    const errSim = sim as sorobanRpc.Api.SimulateTransactionErrorResponse;
    console.log("FULL ERROR:", errSim.error);
  } else {
    console.log("✓ sim SUCCESS");
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
