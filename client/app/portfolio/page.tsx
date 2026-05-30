"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { TopNav } from "@/components/common/TopNav";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { getBalance, getAccountHealth, getPositions } from "@/lib/stellar/contracts";
import { ASSETS } from "@/config";
import { amountToHuman } from "@/lib/format";
import { calcUnrealizedPnl } from "@/lib/math";
import { DepositWithdrawDialog } from "@/features/trade/components/DepositWithdrawDialog";
import { PositionsTable } from "@/features/trade/components/PositionsTable";
import { OpenOrdersTable } from "@/features/trade/components/OpenOrdersTable";
import { OrderHistoryTable } from "@/features/trade/components/OrderHistoryTable";
import { TradeHistoryTable } from "@/features/trade/components/TradeHistoryTable";
import { UsdcLogo } from "@/components/common/AssetLogos";

const TABS = [
  "Balances", "Positions", "Open Orders", "Outcomes", "TWAP",
  "Trade History", "Funding History", "Order History", "Interest", "Deposits and Withdrawals",
] as const;
type Tab = (typeof TABS)[number];

const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);

const usd = (n: number) =>
  "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function PortfolioPage() {
  const { address, connected } = useWalletStore();
  const [tab, setTab] = useState<Tab>("Positions");
  const markPrices = useMarketStore((s) => s.markPrices);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const { data: positions = [] } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  // Historical analytics (realized pnl, volume, deposits, win rate) from indexer.
  const { data: portfolio } = useQuery({
    queryKey: ["portfolio-analytics", address],
    queryFn: async () => {
      const res = await fetch(`/api/portfolio/${address}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json() as Promise<{
        analytics: {
          realizedPnl: number; volume: number; tradeCount: number; winRate: number;
          totalDeposited: number; totalWithdrawn: number; totalFundingPaid: number;
          totalFeesPaid: number; liquidationCount: number;
        } | null;
      }>;
    },
    enabled: !!address && connected,
    refetchInterval: 15_000,
  });

  const equity = health ? amountToHuman(health.equity) : 0;
  const usdcBal = balance !== undefined ? amountToHuman(balance) : 0;
  const unrealizedPnl = positions.reduce((acc, p) => {
    const mp = markPrices[p.marketId];
    return mp ? acc + amountToHuman(calcUnrealizedPnl(p.isLong, p.size, p.entryPrice, mp)) : acc;
  }, 0);
  const a = portfolio?.analytics;
  const realizedPnl = a?.realizedPnl ?? 0;
  const pnl = realizedPnl + unrealizedPnl;
  const volume = a?.volume ?? 0;
  const winRate = a?.winRate ?? 0;

  const stats: [string, string, string?][] = [
    ["PNL (Realized + Unrealized)", usd(pnl), pnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"],
    ["Realized PNL", usd(realizedPnl), realizedPnl >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]"],
    ["Volume", usd(volume)],
    ["Win Rate", `${(winRate * 100).toFixed(1)}%`],
    ["Total Equity", usd(equity)],
    ["Fees Paid", usd(a?.totalFeesPaid ?? 0)],
    ["Net Funding", usd(a?.totalFundingPaid ?? 0)],
  ];

  const actionPill = "px-4 py-[9px] rounded-[8px] text-[13px] border border-[#1f232a] text-[#8a8f97] hover:text-[#e6e6e6] hover:border-[#2a2f37] transition-colors whitespace-nowrap";

  return (
    <div className="min-h-screen bg-black text-[#e6e6e6]" style={{ fontFamily: "var(--font-poppins), 'Poppins', system-ui, sans-serif" }}>
      <TopNav />
      <main className="px-6 py-6 max-w-[1200px] mx-auto">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-4 mb-5">
          <h1 className="text-[34px] font-bold tracking-tight">Portfolio</h1>
          <div className="flex flex-wrap items-center gap-2">
            {["Link Staking", "Swap Stablecoins", "Perps ⇄ Spot", "EVM ⇄ Core", "Account Type", "Send"].map((l) => (
              <button key={l} className={actionPill}>{l}</button>
            ))}
            <DepositWithdrawDialog triggerLabel="Withdraw" defaultTab="withdraw" triggerClassName={actionPill} />
            <DepositWithdrawDialog
              triggerLabel="Deposit"
              defaultTab="deposit"
              triggerClassName="px-4 py-[9px] rounded-[8px] text-[13px] font-semibold bg-[#f7931a] text-[#1a1205] hover:brightness-110 transition whitespace-nowrap"
            />
          </div>
        </div>

        {/* Top grid */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
          {/* Left: volume + fees */}
          <div className="xl:col-span-3 flex flex-col gap-3">
            <Card>
              <Label>14 Day Volume</Label>
              <div className="text-[30px] font-semibold mt-2">{usd(0)}</div>
              <Link>View Volume</Link>
            </Card>
            <Card>
              <div className="flex items-center justify-between">
                <Label>Fees (Taker / Maker)</Label>
                <span className="flex items-center gap-1.5 text-[12.5px] text-[#8a8f97]">Perps <CaretIcon /></span>
              </div>
              <div className="text-[28px] font-semibold mt-2 tabular">0.0350% / 0.0050%</div>
              <Link>View Fee Schedule</Link>
            </Card>
          </div>

          {/* Middle: stats */}
          <div className="xl:col-span-4">
            <Card className="h-full">
              <div className="flex items-center justify-between border-b border-[#1f232a] pb-3 mb-1">
                <span className="flex items-center gap-1.5 text-[13px] text-[#e6e6e6] font-medium">Perps + Spot + Vaults <CaretIcon /></span>
                <span className="flex items-center gap-1.5 text-[12.5px] text-[#8a8f97]">30D <CaretIcon /></span>
              </div>
              {stats.map(([label, value, cls]) => (
                <div key={label} className="flex items-center justify-between py-[7px] text-[13px]">
                  <span className="text-[#8a8f97]">{label}</span>
                  <span className={`tabular font-medium ${cls ?? "text-[#e6e6e6]"}`}>{value}</span>
                </div>
              ))}
            </Card>
          </div>

          {/* Right: chart */}
          <div className="xl:col-span-5">
            <Card className="h-full">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-1">
                  {["Account Value", "PNL", "Perps PNL"].map((t, i) => (
                    <button
                      key={t}
                      className={`px-3 py-1.5 text-[13px] rounded-[6px] transition-colors ${i === 1 ? "text-[#f7931a]" : "text-[#8a8f97] hover:text-[#e6e6e6]"}`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <span className="flex items-center gap-1.5 text-[12.5px] text-[#8a8f97]">30D <CaretIcon /></span>
              </div>
              <PlaceholderChart />
            </Card>
          </div>
        </div>

        {/* Bottom: tabs + table */}
        <div className="mt-3 rounded-xl border border-[#1f232a] bg-[#0f1217] overflow-hidden">
          <div className="flex items-center justify-between border-b border-[#1f232a]">
            <div className="flex overflow-x-auto" style={{ scrollbarWidth: "none" }}>
              {TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`whitespace-nowrap px-4 py-[14px] text-[13px] font-medium relative transition-colors ${
                    tab === t
                      ? "text-[#e6e6e6] after:content-[''] after:absolute after:left-[14px] after:right-[14px] after:bottom-[-1px] after:h-[2px] after:bg-[#f7931a] after:rounded-[2px]"
                      : "text-[#8a8f97] hover:text-[#e6e6e6]"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
            <button className="flex items-center gap-1.5 pr-4 text-[12.5px] text-[#8a8f97] hover:text-[#e6e6e6] transition-colors">
              Filter <CaretIcon />
            </button>
          </div>

          <div className="min-h-[200px]">
            {tab === "Positions" && <PositionsTable marketFilter="all" sideFilter="both" />}
            {tab === "Open Orders" && <OpenOrdersTable marketFilter="all" sideFilter="both" />}
            {tab === "Order History" && <OrderHistoryTable marketFilter="all" sideFilter="both" />}
            {tab === "Trade History" && <TradeHistoryTable marketFilter="all" />}
            {tab === "Balances" && <BalancesTab connected={connected} usdcBal={usdcBal} balanceLoaded={balance !== undefined} />}
            {["Outcomes", "TWAP", "Funding History", "Interest", "Deposits and Withdrawals"].includes(tab) && (
              <Empty text={`No ${tab.toLowerCase()} yet`} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-[#1f232a] bg-[#0f1217] p-5 ${className}`}>{children}</div>;
}
function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[13px] text-[#8a8f97]">{children}</span>;
}
function Link({ children }: { children: React.ReactNode }) {
  return <button className="mt-3 block text-[13px] text-[#f7931a] hover:brightness-110 transition">{children}</button>;
}

function PlaceholderChart() {
  return (
    <div className="relative h-[230px] w-full">
      <div className="absolute left-0 top-0 bottom-6 flex flex-col justify-between text-[11px] text-[#5a5f66] font-mono">
        {[3, 2, 1, 0].map((n) => <span key={n}>{n}</span>)}
      </div>
      <svg className="absolute left-6 right-0 top-0 bottom-0" width="calc(100% - 24px)" height="100%" preserveAspectRatio="none" viewBox="0 0 600 230">
        <line x1="2" y1="6" x2="2" y2="206" stroke="#1f232a" strokeWidth="1" />
        <line x1="2" y1="206" x2="598" y2="206" stroke="#1fae5b" strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function BalancesTab({ connected, usdcBal, balanceLoaded }: { connected: boolean; usdcBal: number; balanceLoaded: boolean }) {
  if (!connected) return <Empty text="Connect a wallet to view balances" />;
  return (
    <table className="w-full text-[12px] tabular">
      <thead>
        <tr className="text-[10px] text-[#5a5f67] font-semibold uppercase tracking-wider">
          <th className="pl-4 pr-2 py-[9px] text-left">Coin</th>
          <th className="px-3 py-[9px] text-right">Total Balance</th>
          <th className="pr-4 pl-2 py-[9px] text-right">Available</th>
        </tr>
      </thead>
      <tbody>
        <tr className="border-t border-[#1f232a]">
          <td className="pl-4 pr-2 py-[12px] text-left">
            <span className="inline-flex items-center gap-2">
              <UsdcLogo size={16} />
              <span className="font-semibold text-[#e6e6e6]">USDC</span>
            </span>
          </td>
          <td className="px-3 py-[12px] text-right text-[#e6e6e6]">{balanceLoaded ? usd(usdcBal) : "—"}</td>
          <td className="pr-4 pl-2 py-[12px] text-right text-[#e6e6e6]">{balanceLoaded ? usd(usdcBal) : "—"}</td>
        </tr>
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-[12px] text-[#5a6585]">
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
      <span className="underline decoration-dotted underline-offset-4">{text}</span>
    </div>
  );
}
