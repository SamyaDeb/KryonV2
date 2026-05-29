import { PRICE_PRECISION, AMOUNT_PRECISION, BPS_PRECISION } from "@/config";

export function priceToHuman(raw: bigint): number {
  return Number(raw * 10000n / PRICE_PRECISION) / 10000;
}

export function humanToPrice(val: number): bigint {
  return BigInt(Math.round(val * Number(PRICE_PRECISION)));
}

export function amountToHuman(raw: bigint): number {
  return Number(raw) / Number(AMOUNT_PRECISION);
}

export function humanToAmount(val: number): bigint {
  return BigInt(Math.round(val * Number(AMOUNT_PRECISION)));
}

export function bpsToPercent(bps: number): number {
  return bps / BPS_PRECISION * 100;
}

export function formatPrice(raw: bigint, decimals = 4): string {
  return priceToHuman(raw).toFixed(decimals);
}

export function formatAmount(raw: bigint, decimals = 4): string {
  return amountToHuman(raw).toFixed(decimals);
}

export function formatUsd(raw: bigint, decimals = 2): string {
  return "$" + amountToHuman(raw).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function formatPnl(raw: bigint): string {
  const val = amountToHuman(raw);
  const sign = val >= 0 ? "+" : "";
  return `${sign}$${Math.abs(val).toFixed(2)}`;
}

export function formatLeverage(bps: number): string {
  return `${(bps / BPS_PRECISION * 100).toFixed(1)}x`;
}

export function formatPercent(bps: number, decimals = 2): string {
  return `${bpsToPercent(bps).toFixed(decimals)}%`;
}

export function formatFundingRate(raw: bigint): string {
  // funding index displayed as hourly rate in bps
  const rate = priceToHuman(raw);
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${(rate * 100).toFixed(4)}%`;
}

export function shortenAddress(addr: string): string {
  if (!addr || addr.length < 12) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export function formatVolume(raw: bigint): string {
  const val = amountToHuman(raw);
  if (val >= 1_000_000_000) return `$${(val / 1_000_000_000).toFixed(2)}B`;
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 1_000) return `$${(val / 1_000).toFixed(2)}K`;
  return `$${val.toFixed(2)}`;
}

export function formatCompact(val: number, decimals = 2): string {
  if (val >= 1_000_000_000) return `${(val / 1_000_000_000).toFixed(decimals)}B`;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(decimals)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(decimals)}K`;
  return val.toFixed(decimals);
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function formatChangePercent(pct: number, decimals = 2): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(decimals)}%`;
}
