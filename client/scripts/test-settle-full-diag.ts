import {
  Keypair, Account, Contract, TransactionBuilder,
  nativeToScVal, Address, xdr, rpc as sorobanRpc
} from "@stellar/stellar-sdk";
import { CONTRACTS, ASSETS, NETWORK } from "@/config";

const FEE = "2000000";
function mapEntry(k: string, v: xdr.ScVal) { return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v }); }
function i128(n: bigint) { return nativeToScVal(n, { type: "i128" }); }
function u64(n: bigint) { return nativeToScVal(n, { type: "u64" }); }
function u32(n: number) { return nativeToScVal(n, { type: "u32" }); }
function addrVal(a: string) { return new Address(a).toScVal(); }
function orderScVal(o: any) {
  return xdr.ScVal.scvMap([
    mapEntry("expiry_ts", u64(o.expiryTs)), mapEntry("is_long", xdr.ScVal.scvBool(o.isLong)),
    mapEntry("limit_price", i128(o.limitPrice)), mapEntry("market_id", u32(o.marketId)),
    mapEntry("nonce", u64(o.nonce)), mapEntry("owner", addrVal(o.owner)),
    mapEntry("reduce_only", xdr.ScVal.scvBool(o.reduceOnly)), mapEntry("size", i128(o.size)),
  ]);
}

async function main() {
  const secret = process.env.ORACLE_PUBLISHER_SECRET!;
  const kp = Keypair.fromSecret(secret);
  const maker = kp.publicKey();
  const taker = "GAA5VLHTEZYTJ7GCIEAXSOZLQKPHDV7KZVQYZB5IMGBASESGDMB6WYMM"; // from prev test
  const server = new sorobanRpc.Server(NETWORK.rpcUrl);
  const account = await server.getAccount(maker);
  const now = BigInt(Math.floor(Date.now()/1000));
  const contract = new Contract(CONTRACTS.orderGateway);

  const fillArg = xdr.ScVal.scvMap([
    mapEntry("fill_price", i128(210000000000000000n)),
    mapEntry("fill_size",  i128(10000000n)),
    mapEntry("maker", orderScVal({ owner:maker, marketId:1, isLong:true, size:10000000n, limitPrice:210000000000000000n, reduceOnly:false, nonce:BigInt(Date.now()), expiryTs:now+3600n })),
    mapEntry("taker", orderScVal({ owner:taker, marketId:1, isLong:false, size:10000000n, limitPrice:209500000000000000n, reduceOnly:false, nonce:BigInt(Date.now()+1), expiryTs:now+3600n })),
  ]);

  const tx = new TransactionBuilder(account, { fee: FEE, networkPassphrase: NETWORK.passphrase })
    .addOperation(contract.call("settle_fill", fillArg)).setTimeout(60).build();
  const sim = await server.simulateTransaction(tx);
  if (sorobanRpc.Api.isSimulationError(sim)) {
    console.log("FULL ERROR:", (sim as any).error);
  } else {
    console.log("✓ SUCCESS — auth entries:", (sim as any).result?.auth?.length);
  }
  process.exit(0);
}
main().catch(e => { console.error(e.message); process.exit(1); });
