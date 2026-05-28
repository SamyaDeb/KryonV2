"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useWalletStore } from "@/store/wallet";
import { useMarketStore } from "@/store/market";
import { MarketConfig, AMOUNT_PRECISION, PRICE_PRECISION, ASSETS } from "@/lib/config";
import { buildOrderIntent } from "@/lib/orders/intent";
import { submitOrder } from "@/lib/orders/matcher";
import { useLocalOrders } from "@/store/orders";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { getBalance } from "@/lib/stellar/contracts";
import { amountToHuman, priceToHuman } from "@/lib/format";
import { freighterConnect, freighterIsInstalled, isOnTestnet } from "@/lib/stellar/freighter";
import { calcLiqPrice } from "@/lib/math";

/* ── Icons ── */
const CaretIcon = () => (
  <svg width={10} height={10} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M3 4.5 L6 7.5 L9 4.5" />
  </svg>
);
const SwapIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M7 7h13l-3-3M17 17H4l3 3" />
  </svg>
);
const FlaskIcon = () => (
  <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6A2 2 0 0 0 19 18l-5-9V3" />
  </svg>
);
const CalcIcon = () => (
  <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01" />
  </svg>
);
const PencilIcon = () => (
  <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
    <path d="M14 4 20 10 9 21H3v-6z" />
  </svg>
);
const CheckIcon = () => (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 6.5 5 9.5 10 3.5" />
  </svg>
);

/* ── Leverage popover ── */
function LeveragePop({
  leverage,
  setLeverage,
  maxLev,
  close,
}: {
  leverage: number;
  setLeverage: (v: number) => void;
  maxLev: number;
  close: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef(false);

  const setFromX = useCallback(
    (clientX: number) => {
      if (!trackRef.current) return;
      const r = trackRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      setLeverage(Math.max(1, Math.round(pct * maxLev)));
    },
    [maxLev, setLeverage]
  );

  useEffect(() => {
    const move = (e: MouseEvent) => { if (drag.current) setFromX(e.clientX); };
    const up = () => { drag.current = false; };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [setFromX]);

  const pct = (leverage / maxLev) * 100;
  const marks = [1, 5, 10, 20, Math.round(maxLev / 2), maxLev].filter(
    (v, i, arr) => arr.indexOf(v) === i
  );

  return (
    <div
      className="absolute right-4 top-[80px] w-[320px] rounded-[12px] border border-[#2a2f37] p-4 z-50"
      style={{ background: "#0d0f13", boxShadow: "0 20px 40px rgba(0,0,0,.6)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <h4 className="text-[14px] font-semibold text-[#e6e6e6] mb-1">Order Leverage</h4>
      <p className="text-[12px] text-[#8a8f97] mb-[14px]">Higher leverage increases liquidation risk.</p>

      <div className="flex items-center justify-between px-[14px] py-[10px] bg-[#14171c] border border-[#1f232a] rounded-[8px] font-mono mb-[10px]">
        <span className="text-[#8a8f97] text-sm">Selected</span>
        <span className="text-[18px] font-medium text-[#f4f4f4]">{leverage}x</span>
      </div>

      <div
        ref={trackRef}
        className="relative h-[36px] my-2 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = true; setFromX(e.clientX); }}
      >
        <div className="absolute top-1/2 left-0 right-0 h-[4px] bg-[#14171c] rounded-[2px] -translate-y-1/2" />
        <div
          className="absolute top-1/2 left-0 h-[4px] rounded-[2px] -translate-y-1/2"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg,#9aa0a6,#f4f4f4)" }}
        />
        <div
          className="absolute top-1/2 w-4 h-4 bg-[#f4f4f4] rounded-full -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${pct}%`, boxShadow: "0 0 0 4px rgba(244,244,244,.12)" }}
        />
      </div>

      <div className="flex justify-between font-mono text-[11px] text-[#5a5f66] mt-[14px]">
        {marks.map((m) => (
          <button
            key={m}
            onClick={() => setLeverage(m)}
            className={`hover:text-[#e6e6e6] transition-colors ${leverage === m ? "text-[#f4f4f4]" : ""}`}
          >
            {m}x
          </button>
        ))}
      </div>

      <div className="flex gap-2 mt-[14px]">
        <button
          onClick={close}
          className="flex-1 py-[10px] rounded-[7px] text-[13px] font-medium bg-[#14171c] border border-[#1f232a] text-[#8a8f97] hover:text-[#e6e6e6] transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={close}
          className="flex-1 py-[10px] rounded-[7px] text-[13px] font-medium text-[#0a0b0d]"
          style={{ background: "linear-gradient(180deg,#e7e7e7,#bfbfbf)" }}
        >
          Confirm
        </button>
      </div>
    </div>
  );
}

/* ── Margin mode popover ── */
function MarginPop({
  margin,
  setMargin,
  close,
}: {
  margin: "Cross" | "Isolated";
  setMargin: (v: "Cross" | "Isolated") => void;
  close: () => void;
}) {
  const opts: Array<["Cross" | "Isolated", string]> = [
    ["Cross", "All Cross positions share the same Cross Margin balance."],
    ["Isolated", "Manage risk on positions individually by allocating a specific margin amount to each position."],
  ];

  return (
    <div
      className="absolute right-4 top-4 w-[300px] rounded-[12px] border border-[#2a2f37] p-[14px] z-50"
      style={{ background: "#0d0f13", boxShadow: "0 20px 40px rgba(0,0,0,.6)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-[6px] pb-3 font-semibold text-[#e6e6e6]">Margin Mode</div>
      {opts.map(([t, d]) => (
        <div
          key={t}
          onClick={() => { setMargin(t); close(); }}
          className={`flex items-start gap-3 p-3 rounded-[8px] cursor-pointer border transition-colors ${
            margin === t
              ? "bg-[#14171c] border-[#2a2f37]"
              : "border-transparent hover:bg-[#14171c]"
          }`}
        >
          <div
            className={`w-[14px] h-[14px] rounded-full border mt-[3px] grid place-items-center shrink-0 ${
              margin === t ? "border-[#f4f4f4]" : "border-[#2a2f37]"
            }`}
          >
            {margin === t && <div className="w-[6px] h-[6px] rounded-full bg-[#f4f4f4]" />}
          </div>
          <div>
            <div className="font-medium text-[#e6e6e6] mb-0.5">{t}</div>
            <div className="text-[12px] text-[#8a8f97] leading-[1.5]">{d}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── Main OrderEntry ── */
export function OrderEntry({ market }: { market: MarketConfig }) {
  const { address, connected, connecting, setAddress, setConnected, setConnecting, setWrongNetwork } =
    useWalletStore();
  const addOrder = useLocalOrders((s) => s.addOrder);
  const { markPrices, orderBooks } = useMarketStore();

  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [mode, setMode] = useState<"market" | "limit">("market");
  const [size, setSize] = useState("");
  const [limitPrice, setLimitPrice] = useState("");

  const sanitizeNumericInput = (val: string): string => {
    // Allow only digits and a single decimal point; strip leading zeros
    const cleaned = val.replace(/[^0-9.]/g, "").replace(/^0+(\d)/, "$1");
    const parts = cleaned.split(".");
    return parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned;
  };
  const [leverage, setLeverage] = useState(15);
  const [margin, setMargin] = useState<"Cross" | "Isolated">("Cross");
  const [reduce, setReduce] = useState(false);
  const [post, setPost] = useState(false);
  const [tpsl, setTpsl] = useState(false);
  const [levOpen, setLevOpen] = useState(false);
  const [marOpen, setMarOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const maxLev = Math.round(market.maxLeverageBps / 10000);

  // Close popovers on outside click
  useEffect(() => {
    if (!levOpen && !marOpen) return;
    function onDoc() { setLevOpen(false); setMarOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [levOpen, marOpen]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  // ── Live mid price: oracle mark → orderbook mid → fallback 0 ───────────────
  const rawMarkPrice = markPrices[market.marketId];
  const book = orderBooks[market.marketId];

  const midPriceHuman: number | null = (() => {
    if (rawMarkPrice && rawMarkPrice > 0n) return priceToHuman(rawMarkPrice);
    if (book?.asks[0] && book?.bids[0]) {
      return (parseFloat(book.asks[0].price) + parseFloat(book.bids[0].price)) / 2;
    }
    return null;
  })();

  const sizeNum = parseFloat(size) || 0;
  const limitPriceNum = parseFloat(limitPrice) || 0;
  const baseSymbol = market.symbol.replace("-PERP", "");

  // Effective execution price: limit price for limit orders, mid for market
  const execPrice = mode === "limit" ? limitPriceNum : (midPriceHuman ?? 0);

  const orderValue = sizeNum > 0 && execPrice > 0
    ? (sizeNum * execPrice).toFixed(2)
    : "0.00";
  const marginRequired = sizeNum > 0 && execPrice > 0
    ? (sizeNum * execPrice / leverage).toFixed(2)
    : "0.00";

  // Estimated liquidation price
  const liqPriceDisplay = (() => {
    if (sizeNum <= 0 || execPrice <= 0) return "—";
    const entryRaw = BigInt(Math.round(execPrice * Number(PRICE_PRECISION)));
    const liq = calcLiqPrice(
      side === "buy",
      entryRaw,
      leverage,
      market.maintenanceMarginBps
    );
    if (liq <= 0n) return "—";
    return "$" + priceToHuman(liq).toFixed(4);
  })();

  // When switching to limit mode, pre-fill with current mid price
  function handleModeChange(m: "market" | "limit") {
    setMode(m);
    if (m === "limit" && midPriceHuman && !limitPrice) {
      setLimitPrice(midPriceHuman.toFixed(4));
    }
  }

  async function handleConnect() {
    const installed = await freighterIsInstalled();
    if (!installed) {
      toast.error("Freighter not found — install from freighter.app then refresh.");
      return;
    }
    setConnecting(true);
    try {
      const addr = await freighterConnect();
      setAddress(addr);
      setConnected(true);
      const ok = await isOnTestnet();
      setWrongNetwork(!ok);
      if (!ok) toast.warning("Switch Freighter to Stellar Testnet.");
      else toast.success("Wallet connected");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setConnecting(false);
    }
  }

  async function handleSubmit() {
    if (!address || !connected) { toast.error("Connect your wallet first"); return; }
    if (!size || sizeNum <= 0) { toast.error("Enter a valid size"); return; }
    if (mode === "limit" && (!limitPrice || limitPriceNum <= 0)) {
      toast.error("Enter a limit price"); return;
    }

    setLoading(true);
    try {
      const rawSize = BigInt(Math.round(sizeNum * Number(AMOUNT_PRECISION)));
      const rawPrice = mode === "limit"
        ? BigInt(Math.round(limitPriceNum * Number(PRICE_PRECISION)))
        : 0n;

      const intent = buildOrderIntent({
        owner: address,
        marketId: market.marketId,
        isLong: side === "buy",
        size: rawSize,
        limitPrice: rawPrice,
        reduceOnly: reduce,
        ttlSeconds: mode === "limit" ? 3600 : 60,
      });
      addOrder(intent);
      const result = await submitOrder(intent);
      if (result.ok) {
        toast.success(`${mode === "limit" ? "Limit" : "Market"} ${side} order submitted`);
      } else {
        toast.warning(`Order stored locally. ${result.error}`);
      }
      setSize("");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const rowCls = "flex justify-between items-center text-[12.5px] text-[#8a8f97]";
  const valCls = "text-[#5a5f66] font-mono";
  const midDisplay = midPriceHuman !== null ? midPriceHuman.toFixed(4) : "—";

  return (
    <div className="relative flex flex-col">
      <div className="flex flex-col gap-[14px] p-4">
        {/* Margin mode */}
        <button
          className="flex items-center justify-between px-4 py-[13px] rounded-[9px] bg-[#14171c] border border-[#1f232a] hover:border-[#2a2f37] transition-colors"
          onClick={(e) => { e.stopPropagation(); setMarOpen(true); }}
        >
          <span className="text-[12.5px] text-[#8a8f97]">Margin Mode</span>
          <div className="flex items-center gap-2 font-medium text-[#e6e6e6]">
            {margin} <CaretIcon />
          </div>
        </button>

        {/* Long / Short */}
        <div className="grid grid-cols-2 rounded-[9px] overflow-hidden bg-[#14171c] border border-[#1f232a]">
          <button
            onClick={() => setSide("buy")}
            className={`py-[13px] text-center text-[14px] font-semibold transition-colors ${
              side === "buy" ? "bg-[#1fae5b] text-white" : "text-[#8a8f97] hover:text-[#e6e6e6]"
            }`}
          >
            Long / Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={`py-[13px] text-center text-[14px] font-semibold transition-colors ${
              side === "sell" ? "bg-[#e34c4c] text-white" : "text-[#8a8f97] hover:text-[#e6e6e6]"
            }`}
          >
            Short / Sell
          </button>
        </div>

        {/* Order type + price display */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex bg-[#14171c] border border-[#1f232a] rounded-[8px] p-[2px]">
            {(["market", "limit"] as const).map((m) => (
              <button
                key={m}
                onClick={() => handleModeChange(m)}
                className={`px-4 py-[7px] rounded-[6px] text-[13px] font-medium font-mono capitalize transition-colors ${
                  mode === m
                    ? "bg-[#3a3d42] text-[#f4f4f4]"
                    : "text-[#8a8f97] hover:text-[#e6e6e6]"
                }`}
              >
                {m.charAt(0).toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 font-mono text-[14px] text-[#e6e6e6]">
            ${mode === "market"
              ? midDisplay
              : limitPriceNum > 0
              ? limitPriceNum.toFixed(4)
              : midDisplay}
            <span
              className="bg-[#14171c] border border-[#1f232a] px-[7px] py-[3px] rounded-[5px] text-[#8a8f97] text-[10.5px]"
              style={{ letterSpacing: ".06em" }}
            >
              {mode === "market" ? "MID" : "LIMIT"}
            </span>
          </div>
        </div>

        {/* Account info */}
        <div className={rowCls}>
          <span>Available to Trade</span>
          <span className={valCls}>
            {connected && balance !== undefined ? `$${amountToHuman(balance).toFixed(2)}` : "—"}
          </span>
        </div>
        <div className={rowCls}>
          <span>Position</span>
          <span className={valCls}>—</span>
        </div>

        <div className="h-px bg-[#1f232a]" />

        {/* Limit price field */}
        {mode === "limit" && (
          <div className="bg-[#14171c] border border-[#1f232a] rounded-[9px] p-[12px] flex flex-col gap-2">
            <div className="flex items-center justify-between text-[12.5px] text-[#8a8f97]">
              <span>Limit Price</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <input
                className="flex-1 bg-transparent border-0 outline-none text-[#e6e6e6] font-mono text-[22px] font-medium text-right w-full"
                placeholder={midDisplay}
                value={limitPrice}
                onChange={(e) => setLimitPrice(sanitizeNumericInput(e.target.value))}
              />
              <button className="flex items-center gap-1.5 px-[10px] py-1 bg-[#0a0b0d] border border-[#1f232a] rounded-[6px] text-[#e6e6e6] text-[13px] font-medium shrink-0">
                USDC
              </button>
            </div>
          </div>
        )}

        {/* Order size field */}
        <div className="bg-[#14171c] border border-[#1f232a] rounded-[9px] p-[12px] flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12.5px] text-[#8a8f97]">
            <div className="flex items-center gap-[5px]">
              <span>Order Size</span>
              <FlaskIcon />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <input
              className="flex-1 bg-transparent border-0 outline-none text-[#e6e6e6] font-mono text-[22px] font-medium text-right w-full"
              placeholder="0"
              value={size}
              onChange={(e) => setSize(sanitizeNumericInput(e.target.value))}
            />
          </div>
          <div className="flex items-center justify-between">
            <button className="flex items-center gap-1.5 px-[10px] py-1 bg-[#0a0b0d] border border-[#1f232a] rounded-[6px] text-[#e6e6e6] text-[13px] font-medium">
              {baseSymbol} <SwapIcon />
            </button>
            <span className="font-mono text-[12px] text-[#5a5f66]">
              ${sizeNum > 0 && midPriceHuman !== null ? (sizeNum * midPriceHuman).toFixed(2) : "0.00"}
            </span>
          </div>
        </div>

        {/* Order leverage */}
        <div
          className="bg-[#14171c] border border-[#1f232a] rounded-[9px] p-[12px] cursor-pointer hover:border-[#2a2f37] transition-colors"
          onClick={(e) => { e.stopPropagation(); setLevOpen(true); }}
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-[6px] text-[12.5px] text-[#8a8f97]">
              Order Leverage <CalcIcon />
            </span>
            <span className="font-mono text-[15px] font-medium text-[#e6e6e6]">{leverage}x</span>
          </div>
        </div>

        {/* Checkboxes */}
        <div className="flex justify-between pt-[2px]">
          <CheckBox checked={reduce} onChange={setReduce} label="Reduce Only" />
          <CheckBox checked={post} onChange={setPost} label="Post Only" />
        </div>
        <CheckBox checked={tpsl} onChange={setTpsl} label="Take Profit / Stop Loss" />

        {/* Place order button */}
        {!connected ? (
          <button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full py-[15px] rounded-[9px] text-[14px] font-semibold text-[#0a0b0d] border border-[#d4d4d4] transition-colors disabled:opacity-50"
            style={{ background: "linear-gradient(180deg,#e7e7e7,#bfbfbf)", letterSpacing: ".01em" }}
            onMouseOver={(e) => (e.currentTarget.style.background = "linear-gradient(180deg,#f5f5f5,#d4d4d4)")}
            onMouseOut={(e) => (e.currentTarget.style.background = "linear-gradient(180deg,#e7e7e7,#bfbfbf)")}
          >
            {connecting ? "Connecting…" : "Connect Wallet"}
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={loading}
            className={`w-full py-[15px] rounded-[9px] text-[14px] font-semibold text-white transition-colors disabled:opacity-50 ${
              side === "buy"
                ? "bg-[#1fae5b] hover:brightness-110"
                : "bg-[#e34c4c] hover:brightness-110"
            }`}
          >
            {loading
              ? "Placing…"
              : `Place ${side === "buy" ? "Long" : "Short"} ${mode === "limit" ? "Limit" : "Market"} Order`}
          </button>
        )}

        {/* Order summary */}
        <div className="flex flex-col gap-2 pt-[6px] border-t border-[#1f232a] mt-1">
          <div className={rowCls}>
            <span>Expected Price</span>
            <span className="font-mono text-[#e6e6e6]">
              {midPriceHuman !== null ? `$${midDisplay}` : "—"}
            </span>
          </div>
          <div className={rowCls}>
            <span>Est. Liquidation Price</span>
            <span className={`font-mono ${liqPriceDisplay !== "—" ? "text-amber-400" : "text-[#e6e6e6]"}`}>
              {liqPriceDisplay}
            </span>
          </div>
          <div className={rowCls}>
            <span>Order Value</span>
            <span className="font-mono text-[#e6e6e6]">${orderValue}</span>
          </div>
          <div className={rowCls}>
            <span>Margin Required</span>
            <span className="font-mono text-[#e6e6e6]">${marginRequired}</span>
          </div>
          <div className={rowCls}>
            <span>Slippage</span>
            <span className="flex items-center gap-[6px] font-mono text-[#e6e6e6]">
              Est: — / Max: 1% <PencilIcon />
            </span>
          </div>
          <div className={rowCls}>
            <span>Fees</span>
            <span className="font-mono text-[#e6e6e6]">0.035%</span>
          </div>
        </div>
      </div>

      {/* Popovers */}
      {levOpen && (
        <LeveragePop
          leverage={leverage}
          setLeverage={setLeverage}
          maxLev={maxLev}
          close={() => setLevOpen(false)}
        />
      )}
      {marOpen && (
        <MarginPop
          margin={margin}
          setMargin={setMargin}
          close={() => setMarOpen(false)}
        />
      )}
    </div>
  );
}

function CheckBox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      className={`flex items-center gap-2 text-[12.5px] transition-colors ${checked ? "text-[#e6e6e6]" : "text-[#8a8f97]"}`}
      onClick={() => onChange(!checked)}
    >
      <div
        className={`w-[14px] h-[14px] rounded-[3px] border grid place-items-center transition-colors ${
          checked ? "bg-[#d4d4d4] border-[#d4d4d4] text-[#0a0b0d]" : "bg-[#14171c] border-[#2a2f37]"
        }`}
      >
        {checked && <CheckIcon />}
      </div>
      {label}
    </button>
  );
}
