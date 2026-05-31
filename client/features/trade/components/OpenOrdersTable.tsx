"use client";

import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { cancelOrder as cancelOnChain } from "@/lib/stellar/contracts";
import { cancelOrderOnMatcher } from "@/lib/market/matcher";
import { priceToHuman, amountToHuman } from "@/lib/format";
import { MARKETS } from "@/config";
import { XlmLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useState } from "react";

export function OpenOrdersTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const { address, connected } = useWalletStore();
  const { orders, cancelOrder } = useLocalOrders();

  const visible = orders.filter(
    (o) =>
      o.status === "pending" &&
      o.owner === address &&
      (marketFilter === "all" || o.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === o.isLong)
  );

  if (!connected || !address) {
    return <Empty text="Connect a wallet to view open orders" />;
  }
  if (visible.length === 0) {
    return <Empty text="No open orders" />;
  }

  const cols = ["Market", "Type", "Side", "Size", "Price", "Reduce", "Status", ""];

  return (
    <table className="w-full text-[12px] tabular">
      <thead>
        <tr className="text-[10px] text-[#737373] font-semibold uppercase tracking-wider">
          {cols.map((h, i) => (
            <th
              key={h || `act-${i}`}
              className={`py-[9px] whitespace-nowrap ${i === 0 ? "pl-4 pr-2 text-left" : i === cols.length - 1 ? "pr-4 pl-2 text-right" : "px-3 text-right"}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {visible.map((order) => (
          <OrderRow
            key={String(order.nonce)}
            order={order}
            onCancel={async () => {
              try {
                await cancelOnChain(address, order.nonce);
                await cancelOrderOnMatcher(address, order.nonce);
                cancelOrder(order.nonce, address);
                toast.success("Order cancelled");
              } catch (e) {
                toast.error(`Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          />
        ))}
      </tbody>
    </table>
  );
}

function OrderRow({
  order,
  onCancel,
}: {
  order: ReturnType<typeof useLocalOrders.getState>["orders"][number];
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);

  const marketName =
    Object.values(MARKETS).find((m) => m.marketId === order.marketId)?.symbol ??
    `#${order.marketId}`;
  const baseSymbol = marketName.replace("-PERP", "");

  const isMarket = order.limitPrice === 0n;
  const priceDisplay = isMarket ? "Market" : `$${priceToHuman(order.limitPrice).toFixed(4)}`;
  const sizeDisplay = amountToHuman(order.size).toFixed(4);

  const sideBadge = order.isLong
    ? "bg-[rgba(31,174,91,0.12)] text-[#1fae5b]"
    : "bg-[rgba(227,76,76,0.12)] text-[#e34c4c]";

  return (
    <tr className="border-t border-[#2A2A31] hover:bg-white/[0.02] transition-colors">
      <td className="pl-4 pr-2 py-[10px] text-left">
        <div className="flex items-center gap-2">
          {baseSymbol === "XLM" ? <XlmLogo size={16} /> : null}
          <span className="font-semibold text-[#f5f5f5]">
            {baseSymbol}
            <span className="text-[#737373] font-normal">/USDC</span>
          </span>
        </div>
      </td>
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">{isMarket ? "Market" : "Limit"}</td>
      <td className="px-3 py-[10px] text-right">
        <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${sideBadge}`}>
          {order.isLong ? "LONG" : "SHORT"}
        </span>
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{sizeDisplay}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">{priceDisplay}</td>
      <td className="px-3 py-[10px] text-right">
        {order.reduceOnly ? (
          <span className="text-[10px] border border-[#334155] text-[#a3a3a3] px-1.5 py-0.5 rounded">Reduce</span>
        ) : (
          <span className="text-[#737373]">—</span>
        )}
      </td>
      <td className="px-3 py-[10px] text-right">
        <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-medium">
          Pending
        </span>
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        <button
          className="px-3 py-1.5 text-[12px] font-semibold rounded-[6px] border border-[#334155] text-[#a3a3a3] hover:text-[#e34c4c] hover:border-[#e34c4c]/40 hover:bg-[#e34c4c]/10 disabled:opacity-50 transition-colors"
          disabled={cancelling}
          onClick={async () => {
            setCancelling(true);
            await onCancel();
            setCancelling(false);
          }}
        >
          {cancelling ? "…" : "Cancel"}
        </button>
      </td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-[#a3a3a3]">
      <span className="text-[13px] text-[#a3a3a3]">{text}</span>
    </div>
  );
}
