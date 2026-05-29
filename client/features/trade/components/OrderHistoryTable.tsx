"use client";

import { useLocalOrders } from "@/stores/orders";
import { priceToHuman, amountToHuman } from "@/lib/format";
import { MARKETS } from "@/config";
import { XlmLogo } from "@/components/common/AssetLogos";

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  filled: "bg-[rgba(31,174,91,0.12)] text-[#1fae5b] border-[#1fae5b]/20",
  cancelled: "bg-[#2a2a30] text-[#8a8f97] border-[#34343a]",
};

function symbolFor(marketId: number): string {
  return (Object.values(MARKETS).find((m) => m.marketId === marketId)?.symbol ?? "").replace("-PERP", "");
}

export function OrderHistoryTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const orders = useLocalOrders((s) => s.orders);
  const rows = orders.filter(
    (o) =>
      (marketFilter === "all" || o.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === o.isLong)
  );

  if (rows.length === 0) return <Empty text="No order history yet" />;

  const cols = ["Time", "Market", "Type", "Side", "Size", "Price", "Status"];

  return (
    <table className="w-full text-[12px] tabular">
      <thead>
        <tr className="text-[10px] text-[#5a5f67] font-semibold uppercase tracking-wider">
          {cols.map((h, i) => (
            <th key={h} className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : "px-3 text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((o) => {
          const isMarket = o.limitPrice === 0n;
          const baseSymbol = symbolFor(o.marketId);
          const sideBadge = o.isLong
            ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
            : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]";
          return (
            <tr key={String(o.nonce)} className="border-t border-[#1f232a] hover:bg-white/[0.02] transition-colors">
              <td className="pl-4 pr-2 py-[10px] text-left text-[#8a8f97]">
                {new Date(Number(o.nonce)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </td>
              <td className="px-3 py-[10px] text-left">
                <span className="inline-flex items-center gap-1.5">
                  {baseSymbol === "XLM" ? <XlmLogo size={15} /> : null}
                  <span className="font-semibold text-[#e6e6e6]">
                    {baseSymbol}
                    <span className="text-[#5a5f67] font-normal">/USDC</span>
                  </span>
                </span>
              </td>
              <td className="px-3 py-[10px] text-right text-[#8a8f97]">{isMarket ? "Market" : "Limit"}</td>
              <td className="px-3 py-[10px] text-right">
                <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${sideBadge}`}>
                  {o.isLong ? "LONG" : "SHORT"}
                </span>
              </td>
              <td className="px-3 py-[10px] text-right text-[#e6e6e6] font-medium">{amountToHuman(o.size).toFixed(4)}</td>
              <td className="px-3 py-[10px] text-right text-[#e6e6e6] font-medium">
                {isMarket ? "Market" : `$${priceToHuman(o.limitPrice).toFixed(4)}`}
              </td>
              <td className="px-3 py-[10px] text-right">
                <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium border capitalize ${STATUS_STYLE[o.status] ?? STATUS_STYLE.cancelled}`}>
                  {o.status}
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-[12px] text-[#5a6585]">
      <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M7 7l10 10M17 7L7 17" />
      </svg>
      <span className="underline decoration-dotted underline-offset-4">{text}</span>
    </div>
  );
}
