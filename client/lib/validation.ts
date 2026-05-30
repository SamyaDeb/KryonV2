// Server-side input validation for order intake. Keeps malformed / abusive
// payloads out of the DB and the matcher. Pure functions — no I/O.

import { StrKey } from "@stellar/stellar-sdk";
import { MARKETS, AMOUNT_PRECISION, PRICE_PRECISION } from "@/config";

const VALID_MARKET_IDS = new Set(Object.values(MARKETS).map((m) => m.marketId));

// Sane absolute bounds (defence-in-depth; on-chain checks are authoritative).
const MAX_SIZE = 1_000_000_000n * AMOUNT_PRECISION;     // 1e9 units
const MAX_PRICE = 10_000_000n * PRICE_PRECISION;        // $10M
const MAX_TTL_SECONDS = 7n * 24n * 3600n;               // 7 days

export interface ValidatedOrder {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;
}

export type ValidationResult =
  | { ok: true; order: ValidatedOrder }
  | { ok: false; error: string };

function parseBigInt(v: unknown): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  try {
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) return null;
    return BigInt(s);
  } catch {
    return null;
  }
}

export function validateOrderIntent(body: unknown): ValidationResult {
  if (typeof body !== "object" || body === null) return { ok: false, error: "Body must be an object" };
  const b = body as Record<string, unknown>;

  // Owner — must be a valid Stellar public key.
  if (typeof b.owner !== "string" || !StrKey.isValidEd25519PublicKey(b.owner)) {
    return { ok: false, error: "Invalid owner address" };
  }

  // Market — must be a known, configured market.
  const marketId = Number(b.market_id);
  if (!Number.isInteger(marketId) || !VALID_MARKET_IDS.has(marketId)) {
    return { ok: false, error: "Unknown market_id" };
  }

  if (typeof b.is_long !== "boolean") return { ok: false, error: "is_long must be boolean" };
  if (typeof b.reduce_only !== "boolean") return { ok: false, error: "reduce_only must be boolean" };

  // Size — positive, within bounds.
  const size = parseBigInt(b.size);
  if (size === null || size <= 0n) return { ok: false, error: "size must be a positive integer" };
  if (size > MAX_SIZE) return { ok: false, error: "size exceeds maximum" };

  // Limit price — >= 0 (0 = market order sentinel), within bounds.
  const limitPrice = parseBigInt(b.limit_price);
  if (limitPrice === null || limitPrice < 0n) return { ok: false, error: "limit_price must be >= 0" };
  if (limitPrice > MAX_PRICE) return { ok: false, error: "limit_price exceeds maximum" };

  // Nonce — non-negative integer.
  const nonce = parseBigInt(b.nonce);
  if (nonce === null || nonce < 0n) return { ok: false, error: "nonce must be a non-negative integer" };

  // Expiry — must be in the future and not absurdly far out.
  const expiryTs = parseBigInt(b.expiry_ts);
  if (expiryTs === null) return { ok: false, error: "expiry_ts must be an integer" };
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiryTs !== 0n) {
    if (expiryTs <= nowSec) return { ok: false, error: "expiry_ts is in the past" };
    if (expiryTs > nowSec + MAX_TTL_SECONDS) return { ok: false, error: "expiry_ts too far in the future" };
  }

  return {
    ok: true,
    order: { owner: b.owner, marketId, isLong: b.is_long, size, limitPrice, reduceOnly: b.reduce_only, nonce, expiryTs },
  };
}
