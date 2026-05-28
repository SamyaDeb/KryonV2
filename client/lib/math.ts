import { PRICE_PRECISION, AMOUNT_PRECISION, BPS_PRECISION } from "./config";

/**
 * Approximate liquidation price for a cross-margin perp position.
 *
 * For a long:  liq = entryPrice * (1 - 1/leverage + maintenanceMarginRate)
 * For a short: liq = entryPrice * (1 + 1/leverage - maintenanceMarginRate)
 *
 * All price values are in 1e18 precision.
 */
export function calcLiqPrice(
  isLong: boolean,
  entryPrice: bigint,
  leverage: number,
  maintenanceMarginBps: number
): bigint {
  if (leverage <= 0 || entryPrice <= 0n) return 0n;

  const SCALE = 1_000_000n;
  const mmRate = BigInt(Math.round((maintenanceMarginBps / BPS_PRECISION) * Number(SCALE)));
  const leverageScaled = BigInt(Math.round(leverage * Number(SCALE)));

  if (isLong) {
    // factor = 1 - 1/leverage + mm_rate  (all scaled by SCALE)
    const factor = SCALE - (SCALE * SCALE) / leverageScaled + mmRate;
    if (factor <= 0n) return 0n;
    return (entryPrice * factor) / SCALE;
  } else {
    // factor = 1 + 1/leverage - mm_rate
    const factor = SCALE + (SCALE * SCALE) / leverageScaled - mmRate;
    return (entryPrice * factor) / SCALE;
  }
}

/**
 * Margin ratio = margin / notional value.  Returns a plain float (0–1+).
 * margin and notional must share the same precision unit (e.g. both AMOUNT_PRECISION).
 */
export function calcMarginRatio(margin: bigint, notional: bigint): number {
  if (notional <= 0n) return 0;
  return Number((margin * 10_000n) / notional) / 10_000;
}

/**
 * Maximum position size (in base asset, AMOUNT_PRECISION units) a trader
 * can open given their available collateral, target leverage, and mark price.
 *
 * maxSize = (collateral * leverage * PRICE_PRECISION) / (markPrice * AMOUNT_PRECISION)
 * Result is in AMOUNT_PRECISION (1e7).
 */
export function calcMaxPositionSize(
  collateral: bigint,
  leverage: number,
  markPrice: bigint
): bigint {
  if (markPrice <= 0n || leverage <= 0 || collateral <= 0n) return 0n;
  const leverageScaled = BigInt(Math.round(leverage * 1_000));
  return (collateral * leverageScaled * PRICE_PRECISION) /
    (markPrice * 1_000n * AMOUNT_PRECISION);
}

/**
 * Unrealized PnL for a position given current mark price.
 * Returns value in AMOUNT_PRECISION (1e7) to match vault balance units.
 *
 * pnl = size * (markPrice - entryPrice) / PRICE_PRECISION   [for long]
 * pnl = size * (entryPrice - markPrice) / PRICE_PRECISION   [for short]
 *
 * size is in AMOUNT_PRECISION (1e7), prices in PRICE_PRECISION (1e18).
 * Result is in AMOUNT_PRECISION (1e7).
 */
export function calcUnrealizedPnl(
  isLong: boolean,
  size: bigint,
  entryPrice: bigint,
  markPrice: bigint
): bigint {
  if (markPrice <= 0n || entryPrice <= 0n || size <= 0n) return 0n;
  const priceDelta = isLong ? markPrice - entryPrice : entryPrice - markPrice;
  return (size * priceDelta) / PRICE_PRECISION;
}
