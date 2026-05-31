"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { getBalance, getAccountHealth } from "@/lib/stellar/contracts";
import { ASSETS } from "@/config";
import { formatUsd, amountToHuman } from "@/lib/format";
import { DepositWithdrawDialog } from "./DepositWithdrawDialog";
import { UsdcLogo } from "@/components/common/AssetLogos";
import type { ReactNode } from "react";

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

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-[11px] border-b border-[#334155]">
      <div className="flex items-center gap-5">
        <Stat
          label="Balance"
          value={balance !== undefined ? formatUsd(balance) : "—"}
          icon={<UsdcLogo size={12} />}
        />
        {health && health.usedMargin > 0n && (
          <Stat
            label="Used Margin"
            value={`$${amountToHuman(health.usedMargin).toFixed(2)}`}
            icon={<UsdcLogo size={12} />}
          />
        )}
      </div>
      <DepositWithdrawDialog />
    </div>
  );
}

function Stat({
  label,
  value,
  valueClass,
  icon,
}: {
  label: string;
  value: string;
  valueClass?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className="text-[10px] text-[#a3a3a3] uppercase tracking-wider">{label}</span>
      <span className={`flex items-center gap-[4px] tabular text-xs font-semibold ${valueClass ?? "text-[#f5f5f5]"}`}>
        {icon}
        {value}
      </span>
    </div>
  );
}
