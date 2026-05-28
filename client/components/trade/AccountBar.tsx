"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/store/wallet";
import { getBalance, getAccountHealth } from "@/lib/stellar/contracts";
import { ASSETS, PRICE_PRECISION } from "@/lib/config";
import { formatUsd, amountToHuman } from "@/lib/format";
import { DepositWithdrawDialog } from "./DepositWithdrawDialog";

export function AccountBar() {
  const { address, connected } = useWalletStore();

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  if (!connected || !address) return null;

  // healthFactor is margin_ratio in 1e18 precision: equity * 1e18 / maintenance_margin
  // Convert to human-readable percentage: (factor / 1e18) * 100
  const healthPct = health && health.healthFactor > 0n
    ? Number(health.healthFactor * 10000n / PRICE_PRECISION) / 100
    : null;

  const healthColor =
    healthPct === null
      ? "text-[#8a8f97]"
      : healthPct > 200
      ? "text-[#1fae5b]"
      : healthPct > 120
      ? "text-amber-400"
      : "text-[#e34c4c]";

  return (
    <div className="flex items-center gap-4 text-xs">
      <Stat label="Balance" value={balance !== undefined ? formatUsd(balance) : "—"} />
      {health && (
        <Stat
          label="Equity"
          value={formatUsd(health.equity)}
        />
      )}
      {health && health.usedMargin > 0n && (
        <Stat
          label="Used Margin"
          value={`$${amountToHuman(health.usedMargin).toFixed(2)}`}
        />
      )}
      {healthPct !== null && (
        <Stat
          label="Health"
          value={`${healthPct.toFixed(0)}%`}
          valueClass={healthColor}
        />
      )}
      <DepositWithdrawDialog />
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[10px] text-[#3d4f6b] uppercase tracking-wider">{label}</span>
      <span className={`tabular text-xs font-semibold ${valueClass ?? "text-[#dde2ef]"}`}>{value}</span>
    </div>
  );
}
