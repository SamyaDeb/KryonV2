"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { MARKETS, STELLAR_EXPERT_URL } from "@/config";
import { XlmLogo } from "@/components/common/AssetLogos";

interface Fill {
  id: string | number;
  marketId: number;
  isMaker: boolean;
  price: number;
  size: number;
  txHash: string;
  createdAt: number;
}

function symbolFor(marketId: number): string {
  return (Object.values(MARKETS).find((m) => m.marketId === marketId)?.symbol ?? "").replace("-PERP", "");
}

export function TradeHistoryTable({ marketFilter }: { marketFilter: number | "all" }) {
  const { address, connected } = useWalletStore();

  const { data: fills = [] } = useQuery<Fill[]>({
    queryKey: ["fills", address],
    queryFn: async () => {
      const res = await fetch(`/api/fills?address=${address}&limit=50`, { cache: "no-store" });
      if (!res.ok) return [];
      return (await res.json()) as Fill[];
    },
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  if (!connected || !address) return <Empty text="Connect a wallet to view trade history" />;

  const rows = fills.filter((f) => marketFilter === "all" || f.marketId === marketFilter);
  if (rows.length === 0) return <Empty text="No trades yet" />;

  const cols = ["Time", "Market", "Role", "Size", "Price", "Tx"];

  return (
    <table className="w-full text-[12px] tabular">
      <thead>
        <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
          {cols.map((h, i) => (
            <th key={h} className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === 1 ? "px-3 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((f) => {
          const onChain = f.txHash && !f.txHash.startsWith("dbfill");
          const baseSymbol = symbolFor(f.marketId);
          return (
            <tr key={String(f.id)} className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
              <td className="pl-4 pr-2 py-[10px] text-left text-[#a3a3a3]">
                {new Date(f.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
              </td>
              <td className="px-3 py-[10px] text-left">
                <span className="inline-flex items-center gap-1.5">
                  {baseSymbol === "XLM" ? <XlmLogo size={15} /> : null}
                  <span className="font-semibold text-[#f5f5f5]">
                    {baseSymbol}
                    <span className="text-[#737373] font-normal">/USDC</span>
                  </span>
                </span>
              </td>
              <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{f.isMaker ? "Maker" : "Taker"}</td>
              <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{f.size.toFixed(4)}</td>
              <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">${f.price.toFixed(4)}</td>
              <td className="pr-4 pl-2 py-[10px] text-right">
                {onChain ? (
                  <a
                    href={`${STELLAR_EXPERT_URL}/tx/${f.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-mono text-[#a3a3a3] underline decoration-dotted underline-offset-4 hover:text-[#f5f5f5]"
                  >
                    {f.txHash.slice(0, 8)}…
                  </a>
                ) : (
                  <span className="text-[#737373]">—</span>
                )}
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
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
