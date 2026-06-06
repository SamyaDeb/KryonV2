import { StrKey } from "@stellar/stellar-sdk";
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

function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** Lowercase hex of the ed25519 public key behind a Stellar G-address. */
export function pubkeyHexFromAddress(address: string): string {
  return toHex(StrKey.decodeEd25519PublicKey(address));
}

/**
 * Canonical settlement message for the on-chain signature-verified settlement
 * path (perp-order-gateway::settle_fill_signed). This MUST byte-match the
 * contract's `order_canonical_bytes`, which is enforced by the cross-language
 * golden test `canonical_digest_matches_offchain_golden` in the gateway crate.
 *
 * Layout (ASCII, '|'-separated):
 *   <domain>|place_order|<pubkey_hex>|<market_id>|<is_long 0/1>|<size>|
 *   <limit_price>|<reduce_only 0/1>|<nonce>|<expiry_ts>
 *
 * `domain` is the value passed to gateway.set_domain (the network passphrase).
 * The wallet signs this via SEP-53 (sha256("Stellar Signed Message:\n" || msg)).
 */
export function orderSettlementMessage(
  domain: string,
  pubkeyHex: string,
  o: Omit<SignedOrderPayload, "signature">,
): string {
  return [
    domain,
    "place_order",
    pubkeyHex,
    o.market_id,
    o.is_long ? 1 : 0,
    o.size,
    o.limit_price,
    o.reduce_only ? 1 : 0,
    o.nonce,
    o.expiry_ts,
  ].join("|");
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
