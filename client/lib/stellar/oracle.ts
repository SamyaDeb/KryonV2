"use client";

import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { simulateRead } from "./invoke";
import { CONTRACTS } from "../config";

const DUMMY_SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

// Asset symbol as published by the oracle keeper. Must match what write_price was called with.
const ASSET_SYMBOL_XLM = "XLM";

export interface OraclePriceResult {
  price: bigint;       // 1e18 precision
  confidence: bigint;  // 1e18 precision
  publishTime: number;
}

export async function getOraclePrice(
  assetSymbol: string = ASSET_SYMBOL_XLM
): Promise<OraclePriceResult | null> {
  try {
    // Soroban Symbol arg for the asset
    const assetArg = nativeToScVal(assetSymbol, { type: "symbol" });
    // Option<OracleGuard>::None → ScVoid
    const guardArg = xdr.ScVal.scvVoid();

    const val = await simulateRead(
      CONTRACTS.oracleAdapter,
      "get_price",
      [assetArg, guardArg],
      DUMMY_SOURCE
    );

    if (!val) return null;

    const native = scValToNative(val) as Record<string, unknown>;
    const price = native["price"];
    const confidence = native["confidence"];
    const publishTime = native["publish_time"];

    if (price === undefined || price === null) return null;

    return {
      price: BigInt(String(price)),
      confidence: confidence !== undefined ? BigInt(String(confidence)) : 0n,
      publishTime: Number(publishTime ?? 0),
    };
  } catch {
    return null;
  }
}
