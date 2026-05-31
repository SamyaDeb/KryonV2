"use client";

import { useQuery } from "@tanstack/react-query";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { getPositions, getAccountHealth, RawPosition } from "@/lib/stellar/contracts";
import { MARKETS } from "@/config";
import { priceToHuman, amountToHuman } from "@/lib/format";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useLocalOrders } from "@/stores/orders";
import { calcUnrealizedPnl } from "@/lib/math";
import { useTradeSettings } from "@/stores/settings";
import { XlmLogo, UsdcLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useState } from "react";

export function PositionsTable({
  marketFilter,
  sideFilter,
}: {
  marketFilter: number | "all";
  sideFilter: "both" | "long" | "short";
}) {
  const { address, connected } = useWalletStore();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const markPrices = useMarketStore((s) => s.markPrices);
  const { hidePnl, hideLiqPrice } = useTradeSettings();

  const { data: positions = [], refetch } = useQuery({
    queryKey: ["positions", address],
    queryFn: () => getPositions(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  // Account-level health drives leverage / liq-price / margin (the engine keeps
  // margin at the vault, so position.margin is always 0 — never use it).
  const { data: health } = useQuery({
    queryKey: ["health", address],
    queryFn: () => getAccountHealth(address!),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });
  const equityHuman = health ? amountToHuman(health.equity) : 0;

  const filtered = positions.filter(
    (p) =>
      (marketFilter === "all" || p.marketId === marketFilter) &&
      (sideFilter === "both" || (sideFilter === "long") === p.isLong)
  );

  if (!connected || !address) {
    return <Empty text="Connect a wallet to view open positions" />;
  }
  if (filtered.length === 0) {
    return <Empty text="No open positions" />;
  }

  const cols = [
    "Market",
    "Size",
    "Entry Price",
    "Mark Price",
    ...(hidePnl ? [] : ["PnL"]),
    ...(hideLiqPrice ? [] : ["Liq. Price"]),
    "Margin",
    "",
  ];

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
        {filtered.map((pos) => (
          <PositionRow
            key={String(pos.positionId)}
            position={pos}
            markPrice={markPrices[pos.marketId]}
            equity={equityHuman}
            hidePnl={hidePnl}
            hideLiqPrice={hideLiqPrice}
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
  );
}

function PositionRow({
  position,
  markPrice,
  equity,
  onClose,
  hidePnl,
  hideLiqPrice,
}: {
  position: RawPosition;
  markPrice: bigint | undefined;
  equity: number;
  onClose: () => void;
  hidePnl: boolean;
  hideLiqPrice: boolean;
}) {
  const [closing, setClosing] = useState(false);

  const market = Object.values(MARKETS).find((m) => m.marketId === position.marketId);
  const marketName = market?.symbol ?? `#${position.marketId}`;
  const baseSymbol = marketName.replace("-PERP", "");

  const entryHuman = priceToHuman(position.entryPrice);
  const sizeHuman = amountToHuman(position.size);
  const markHuman = markPrice ? priceToHuman(markPrice) : null;
  const refPrice = markHuman ?? entryHuman;

  const pnl = markPrice
    ? calcUnrealizedPnl(position.isLong, position.size, position.entryPrice, markPrice)
    : null;
  const pnlHuman = pnl !== null ? amountToHuman(pnl) : null;
  const pnlColor =
    pnlHuman === null ? "text-[#a3a3a3]" : pnlHuman >= 0 ? "text-[#1fae5b]" : "text-[#e34c4c]";

  // Position notional and the margin backing it (initial-margin requirement).
  const notional = sizeHuman * refPrice;
  const imRate = (market?.initialMarginBps ?? 0) / 10_000;
  const positionMargin = notional * imRate;

  // PnL% is return on the margin committed to the position.
  const pnlPct =
    pnlHuman !== null && positionMargin > 0 ? (pnlHuman / positionMargin) * 100 : null;

  // Account leverage = notional exposure / account equity.
  const lev =
    equity > 0 && notional > 0 ? Math.max(1, Math.round(notional / equity)) : 0;

  // Cross-margin liquidation price from current account equity:
  //   long:  P = (size*mark - equity) / (size*(1 - mm))
  //   short: P = (equity + size*mark) / (size*(1 + mm))
  const liqPrice = (() => {
    const mm = (market?.maintenanceMarginBps ?? 0) / 10_000;
    if (!market || sizeHuman <= 0 || equity <= 0 || refPrice <= 0) return null;
    let p: number;
    if (position.isLong) {
      const denom = sizeHuman * (1 - mm);
      if (denom <= 0) return null;
      p = (sizeHuman * refPrice - equity) / denom;
    } else {
      p = (equity + sizeHuman * refPrice) / (sizeHuman * (1 + mm));
    }
    if (!isFinite(p) || p <= 0) return null; // unreachable / over-collateralized
    return "$" + p.toFixed(4);
  })();

  const sideBadge = position.isLong
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
          <span className={`rounded-[5px] px-1.5 py-0.5 text-[10px] font-bold tracking-wide ${sideBadge}`}>
            {lev > 0 ? `${lev}× ` : ""}
            {position.isLong ? "LONG" : "SHORT"}
          </span>
        </div>
      </td>
      <td className="px-3 py-[10px] text-right">
        <span className={`font-semibold ${position.isLong ? "text-[#1fae5b]" : "text-[#e34c4c]"}`}>
          {sizeHuman.toFixed(4)}
        </span>{" "}
        <span className="text-[#737373]">{baseSymbol}</span>
      </td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">${entryHuman.toFixed(4)}</td>
      <td className="px-3 py-[10px] text-right text-[#f5f5f5] font-medium">
        {markHuman !== null ? `$${markHuman.toFixed(4)}` : "—"}
      </td>
      {!hidePnl && (
        <td className={`px-3 py-[10px] text-right font-semibold ${pnlColor}`}>
          {pnlHuman !== null ? (
            <>
              {pnlHuman >= 0 ? "+" : ""}${Math.abs(pnlHuman).toFixed(2)}
              {pnlPct !== null && (
                <span className="text-[11px] ml-1">
                  ({pnlPct >= 0 ? "+" : ""}
                  {pnlPct.toFixed(2)}%)
                </span>
              )}
            </>
          ) : (
            "—"
          )}
        </td>
      )}
      {!hideLiqPrice && (
        <td className="px-3 py-[10px] text-right text-amber-400">{liqPrice ?? "—"}</td>
      )}
      <td className="px-3 py-[10px] text-right text-[#a3a3a3]">
        <span className="inline-flex items-center justify-end gap-1">
          {positionMargin.toFixed(2)} <UsdcLogo size={12} />
        </span>
      </td>
      <td className="pr-4 pl-2 py-[10px] text-right">
        <button
          className="px-3 py-1.5 text-[12px] font-semibold rounded-[6px] border border-[#334155] text-[#f5f5f5] hover:bg-[#212128] hover:border-[#475569] disabled:opacity-50 transition-colors"
          disabled={closing}
          onClick={async () => {
            setClosing(true);
            await onClose();
            setClosing(false);
          }}
        >
          {closing ? "Closing…" : "Close"}
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
