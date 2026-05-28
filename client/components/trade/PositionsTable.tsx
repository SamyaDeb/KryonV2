"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/store/wallet";
import { useMarketStore } from "@/store/market";
import { getPositions, RawPosition } from "@/lib/stellar/contracts";
import { MARKETS } from "@/lib/config";
import { formatAmount, priceToHuman, amountToHuman } from "@/lib/format";
import { buildOrderIntent } from "@/lib/orders/intent";
import { submitOrder } from "@/lib/orders/matcher";
import { useLocalOrders } from "@/store/orders";
import { calcUnrealizedPnl, calcLiqPrice } from "@/lib/math";
import { toast } from "sonner";
import { useState } from "react";

export function PositionsTable({ marketId }: { marketId: number }) {
  const { address, connected } = useWalletStore();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const { markPrices } = useMarketStore();

  const { data: positions = [], refetch } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  const filtered = positions.filter((p) => p.marketId === marketId);

  if (!connected || !address) {
    return <Empty text="Connect wallet to see positions" />;
  }
  if (filtered.length === 0) {
    return <Empty text="No open positions" />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[#1a2240]">
            {["Market", "Side", "Size", "Entry", "Mark", "PnL", "Liq Price", "Margin", ""].map((h) => (
              <th
                key={h}
                className="px-4 py-2 text-left text-[10px] text-[#3d4f6b] font-medium uppercase tracking-wider whitespace-nowrap"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {filtered.map((pos) => (
            <PositionRow
              key={String(pos.positionId)}
              position={pos}
              markPrice={markPrices[pos.marketId]}
              onClose={async () => {
                if (!address) return;
                const intent = buildOrderIntent({
                  owner: address,
                  marketId: pos.marketId,
                  isLong: !pos.isLong,
                  size: pos.size,
                  limitPrice: 0n,
                  reduceOnly: true,
                  ttlSeconds: 60,
                });
                addOrder(intent);
                const result = await submitOrder(intent);
                if (result.ok) toast.success("Close order submitted");
                else toast.warning(`Close order stored locally. ${result.error}`);
                refetch();
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PositionRow({
  position,
  markPrice,
  onClose,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  onClose: () => void;
}) {
  const [closing, setClosing] = useState(false);

  const marketName =
    Object.values(MARKETS).find((m) => m.marketId === position.marketId)?.symbol ??
    `#${position.marketId}`;

  const entryHuman = priceToHuman(position.entryPrice);
  const sizeHuman = amountToHuman(position.size);

  // Live mark price
  const markHuman = markPrice ? priceToHuman(markPrice) : null;

  // Unrealized PnL using live mark price
  const pnl = markPrice
    ? calcUnrealizedPnl(position.isLong, position.size, position.entryPrice, markPrice)
    : null;
  const pnlHuman = pnl !== null ? amountToHuman(pnl) : null;
  const pnlColor =
    pnlHuman === null
      ? "text-[#5a6585]"
      : pnlHuman >= 0
      ? "text-[#1fae5b]"
      : "text-[#e34c4c]";

  // Approximate liquidation price — derive leverage from size/margin ratio
  const market = Object.values(MARKETS).find((m) => m.marketId === position.marketId);
  const liqPrice = (() => {
    if (!market || position.entryPrice <= 0n || position.margin <= 0n) return null;
    // notional = size (1e7) * entryPrice (1e18) / 1e18 = size in AMOUNT units
    // leverage ≈ notional / margin  (both in 1e7 units)
    const leverageApprox = Number(position.size) / Number(position.margin);
    const lev = Math.max(1, Math.round(leverageApprox));
    const liq = calcLiqPrice(position.isLong, position.entryPrice, lev, market.maintenanceMarginBps);
    return liq > 0n ? "$" + priceToHuman(liq).toFixed(4) : null;
  })();

  return (
    <tr className="border-b border-[#1a2240]/60 hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-2 text-[#dde2ef] font-semibold">{marketName}</td>
      <td className={`px-4 py-2 font-bold text-xs ${position.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
        {position.isLong ? "LONG" : "SHORT"}
      </td>
      <td className="px-4 py-2 tabular text-[#dde2ef]">{sizeHuman.toFixed(4)}</td>
      <td className="px-4 py-2 tabular text-[#dde2ef]">${entryHuman.toFixed(4)}</td>
      <td className="px-4 py-2 tabular text-[#dde2ef]">
        {markHuman !== null ? `$${markHuman.toFixed(4)}` : "—"}
      </td>
      <td className={`px-4 py-2 tabular font-medium ${pnlColor}`}>
        {pnlHuman !== null
          ? `${pnlHuman >= 0 ? "+" : ""}$${Math.abs(pnlHuman).toFixed(2)}`
          : "—"}
      </td>
      <td className="px-4 py-2 tabular text-amber-400 text-[11px]">
        {liqPrice ?? "—"}
      </td>
      <td className="px-4 py-2 tabular text-[#8891b8]">{formatAmount(position.margin, 2)} USDC</td>
      <td className="px-4 py-2">
        <button
          className="h-6 px-2.5 text-[11px] font-semibold rounded border border-[#e34c4c]/25 text-[#e34c4c] hover:bg-[#e34c4c]/10 disabled:opacity-50 transition-colors"
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            await onClose();
            setClosing(false);
          }}
        >
          {closing ? "…" : "Close"}
        </button>
      </td>
    </tr>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-8 text-[11px] text-[#3d4f6b]">
      {text}
    </div>
  );
}
