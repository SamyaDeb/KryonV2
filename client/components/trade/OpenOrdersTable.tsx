"use client";

import { useWalletStore } from "@/store/wallet";
import { useLocalOrders } from "@/store/orders";
import { cancelOrder as cancelOnChain } from "@/lib/stellar/contracts";
import { cancelOrderOnMatcher } from "@/lib/orders/matcher";
import { priceToHuman, amountToHuman } from "@/lib/format";
import { MARKETS } from "@/lib/config";
import { toast } from "sonner";
import { useState } from "react";

export function OpenOrdersTable({ marketId }: { marketId: number }) {
  const { address, connected } = useWalletStore();
  const { orders, cancelOrder } = useLocalOrders();

  const visible = orders.filter(
    (o) => o.marketId === marketId && o.status === "pending"
  );

  if (!connected || !address) {
    return <Empty text="Connect wallet to see orders" />;
  }
  if (visible.length === 0) {
    return <Empty text="No open orders" />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[#1a2240]">
            {["Market", "Type", "Side", "Size", "Price", "Reduce", "Status", ""].map((h) => (
              <th key={h} className="px-4 py-2 text-left text-[10px] text-[#3d4f6b] font-medium uppercase tracking-wider whitespace-nowrap">
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
              address={address}
              onCancel={async () => {
                try {
                  await cancelOnChain(address, order.nonce);
                  cancelOrderOnMatcher(address, order.nonce);
                  cancelOrder(order.nonce);
                  toast.success("Order cancelled");
                } catch {
                  cancelOrder(order.nonce);
                  toast.info("Order cancelled locally");
                }
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OrderRow({
  order,
  onCancel,
}: {
  order: ReturnType<typeof useLocalOrders.getState>["orders"][number];
  address: string;
  onCancel: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);

  const marketName =
    Object.values(MARKETS).find((m) => m.marketId === order.marketId)?.symbol ??
    `#${order.marketId}`;

  const isMarket = order.limitPrice === 0n;
  const priceDisplay = isMarket ? "Market" : `$${priceToHuman(order.limitPrice).toFixed(4)}`;
  const sizeDisplay = amountToHuman(order.size).toFixed(4);

  return (
    <tr className="border-b border-[#1a2240]/60 hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-2 text-[#dde2ef] font-semibold">{marketName}</td>
      <td className="px-4 py-2 text-[#8891b8]">{isMarket ? "Market" : "Limit"}</td>
      <td className={`px-4 py-2 font-bold ${order.isLong ? "text-[#00d48a]" : "text-[#ff3858]"}`}>
        {order.isLong ? "LONG" : "SHORT"}
      </td>
      <td className="px-4 py-2 tabular text-[#dde2ef]">{sizeDisplay}</td>
      <td className="px-4 py-2 tabular text-[#dde2ef]">{priceDisplay}</td>
      <td className="px-4 py-2">
        {order.reduceOnly ? (
          <span className="text-[10px] border border-[#1a2240] text-[#7b88a8] px-1.5 py-0.5 rounded">
            Reduce
          </span>
        ) : (
          <span className="text-[#3d4f6b]">—</span>
        )}
      </td>
      <td className="px-4 py-2">
        <span className="text-[10px] bg-amber-500/10 text-amber-400 border border-amber-500/20 px-1.5 py-0.5 rounded font-medium">
          Pending
        </span>
      </td>
      <td className="px-4 py-2">
        <button
          className="h-6 px-2.5 text-[11px] font-semibold rounded text-[#5a6585] hover:text-[#ff3858] hover:bg-[#ff3858]/10 disabled:opacity-50 transition-colors"
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
    <div className="flex items-center justify-center h-full text-[11px] text-[#3d4f6b]">
      {text}
    </div>
  );
}
