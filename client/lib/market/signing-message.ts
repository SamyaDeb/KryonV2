import { NETWORK } from "@/config";
import type { OrderIntent } from "./order-intent";

const APP_DOMAIN = "kryon.perps";
const MAX_U64 = (1n << 64n) - 1n;

export interface SignedOrderPayload {
  owner: string;
  market_id: number;
  is_long: boolean;
  size: string;
  limit_price: string;
  reduce_only: boolean;
  nonce: string;
  expiry_ts: string;
  signature: string;
}

export interface SignedCancelPayload {
  owner: string;
  nonce: string;
  signature: string;
}

function canonicalPairs(pairs: Array<[string, string | number | boolean]>): string {
  return pairs.map(([k, v]) => `${k}=${String(v)}`).join("\n");
}

export function orderSigningMessage(o: OrderIntent | Omit<SignedOrderPayload, "signature">): string {
  const marketId = "marketId" in o ? o.marketId : o.market_id;
  const limitPrice = "limitPrice" in o ? o.limitPrice.toString() : o.limit_price;
  const reduceOnly = "reduceOnly" in o ? o.reduceOnly : o.reduce_only;
  const expiryTs = "expiryTs" in o ? o.expiryTs.toString() : o.expiry_ts;
  const isLong = "isLong" in o ? o.isLong : o.is_long;

  return canonicalPairs([
    ["domain", APP_DOMAIN],
    ["action", "place_order"],
    ["network", NETWORK.passphrase],
    ["owner", o.owner],
    ["market_id", marketId],
    ["is_long", isLong],
    ["size", o.size.toString()],
    ["limit_price", limitPrice],
    ["reduce_only", reduceOnly],
    ["nonce", o.nonce.toString()],
    ["expiry_ts", expiryTs],
  ]);
}

export function cancelSigningMessage(owner: string, nonce: bigint | string): string {
  return canonicalPairs([
    ["domain", APP_DOMAIN],
    ["action", "cancel_order"],
    ["network", NETWORK.passphrase],
    ["owner", owner],
    ["nonce", nonce.toString()],
  ]);
}

export function assertU64(n: bigint): boolean {
  return n >= 0n && n <= MAX_U64;
}
