"use client";

// Order intent — builds a signed Order struct for submission to the off-chain matcher.
// The matcher pairs maker+taker and co-submits order_gateway.settle_fill on-chain.

export interface OrderIntent {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;       // i128 in AMOUNT_PRECISION (1e7)
  limitPrice: bigint; // i128 in PRICE_PRECISION (1e18); 0 = market order sentinel
  reduceOnly: boolean;
  nonce: bigint;
  expiryTs: bigint;   // unix seconds
}

export function buildOrderIntent(params: {
  owner: string;
  marketId: number;
  isLong: boolean;
  size: bigint;
  limitPrice: bigint;
  reduceOnly?: boolean;
  ttlSeconds?: number;
}): OrderIntent {
  return {
    owner: params.owner,
    marketId: params.marketId,
    isLong: params.isLong,
    size: params.size,
    limitPrice: params.limitPrice,
    reduceOnly: params.reduceOnly ?? false,
    nonce: BigInt(Date.now()),
    expiryTs: BigInt(Math.floor(Date.now() / 1000) + (params.ttlSeconds ?? 300)),
  };
}

export function orderIntentToJson(o: OrderIntent): Record<string, string | number | boolean> {
  return {
    owner: o.owner,
    market_id: o.marketId,
    is_long: o.isLong,
    size: o.size.toString(),
    limit_price: o.limitPrice.toString(),
    reduce_only: o.reduceOnly,
    nonce: o.nonce.toString(),
    expiry_ts: o.expiryTs.toString(),
  };
}
