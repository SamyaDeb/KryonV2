"use client";

import { useState, useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useMarketStore } from "@/stores/market";
import { MarketConfig, AMOUNT_PRECISION, PRICE_PRECISION, ASSETS } from "@/config";
import { buildOrderIntent } from "@/lib/market/order-intent";
import { submitOrder } from "@/lib/market/matcher";
import { useLocalOrders } from "@/stores/orders";
import { toast } from "sonner";
import { useQuery } from "@tanstack/react-query";
import { getBalance } from "@/lib/stellar/contracts";
import { amountToHuman, priceToHuman } from "@/lib/format";
import { freighterConnect, freighterIsInstalled, isOnTestnet } from "@/lib/stellar/freighter";
import { calcLiqPrice } from "@/lib/math";
import { UsdcLogo, XlmLogo } from "@/components/common/AssetLogos";

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
      className="absolute right-4 top-4 w-[300px] rounded-[12px] border border-[#3f3f47] p-[14px] z-50"
      style={{ background: "#1c1c20", boxShadow: "0 20px 40px rgba(0,0,0,.6)" }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="px-[6px] pb-3 font-semibold text-[#e6e6e6]">Margin Mode</div>
      {opts.map(([t, d]) => (
        <div
          key={t}
          onClick={() => { setMargin(t); close(); }}
          className={`flex items-start gap-3 p-3 rounded-[8px] cursor-pointer border transition-colors ${
            margin === t
              ? "bg-[#26262b] border-[#3f3f47]"
              : "border-transparent hover:bg-[#26262b]"
          }`}
        >
          <div
            className={`w-[14px] h-[14px] rounded-full border mt-[3px] grid place-items-center shrink-0 ${
              margin === t ? "border-[#f4f4f4]" : "border-[#3f3f47]"
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
  const rawMarkPrice = useMarketStore((s) => s.markPrices[market.marketId]);
  const book = useMarketStore((s) => s.orderBooks[market.marketId]);
  const selectedPrice = useMarketStore((s) => s.selectedPrice[market.marketId]);

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
  const [marOpen, setMarOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const maxLev = Math.round(market.maxLeverageBps / 10000);
  const levMarks = [1, 5, 10, 20, Math.round(maxLev / 2), maxLev].filter(
    (v, i, arr) => v >= 1 && v <= maxLev && arr.indexOf(v) === i
  );

  // Close the margin-mode popover on outside click
  useEffect(() => {
    if (!marOpen) return;
    function onDoc() { setMarOpen(false); }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [marOpen]);

  // Picking a price in the order book / trades feed loads it as a limit price.
  useEffect(() => {
    if (selectedPrice != null && selectedPrice > 0) {
      setMode("limit");
      setLimitPrice(selectedPrice.toFixed(4));
    }
  }, [selectedPrice]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && connected,
    refetchInterval: 10_000,
  });

  // ── Live mid price: oracle mark → orderbook mid → fallback 0 ───────────────
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
          className="flex items-center justify-center gap-2 px-4 py-[13px] rounded-[9px] bg-[#26262b] border border-[#34343a] hover:border-[#3f3f47] transition-colors text-[13px] font-medium text-[#e6e6e6]"
          onClick={(e) => { e.stopPropagation(); setMarOpen(true); }}
        >
          {margin} <CaretIcon />
        </button>

        {/* Long / Short */}
        <div className="grid grid-cols-2 rounded-[9px] overflow-hidden bg-[#26262b] border border-[#34343a]">
          <button
            onClick={() => setSide("buy")}
            className={`py-[13px] text-center text-[14px] font-semibold transition-colors ${
              side === "buy" ? "bg-[#1fae5b] text-white" : "text-[#8a8f97] hover:text-[#e6e6e6]"
            }`}
          >
            Long/Buy
          </button>
          <button
            onClick={() => setSide("sell")}
            className={`py-[13px] text-center text-[14px] font-semibold transition-colors ${
              side === "sell" ? "bg-[#e8716f] text-white" : "text-[#8a8f97] hover:text-[#e6e6e6]"
            }`}
          >
            Short/Sell
          </button>
        </div>

        {/* Order type + price display */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex gap-1">
            {(["market", "limit"] as const).map((m) => {
              const ac = side === "buy" ? "#1fae5b" : "#e8716f";
              const active = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => handleModeChange(m)}
                  className="px-4 py-[7px] rounded-[7px] text-[13px] font-medium font-mono capitalize transition-colors border"
                  style={
                    active
                      ? { borderColor: ac, color: ac, background: "transparent" }
                      : { borderColor: "transparent", color: "#8a8f97", background: "#26262b" }
                  }
                >
                  {m.charAt(0).toUpperCase() + m.slice(1)}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 px-[12px] py-[9px] rounded-[8px] bg-[#1c1c20] font-mono text-[14px] text-[#e6e6e6]">
            ${mode === "market"
              ? midDisplay
              : limitPriceNum > 0
              ? limitPriceNum.toFixed(4)
              : midDisplay}
            <span
              className="bg-[#3a3a42] px-[7px] py-[3px] rounded-[5px] text-[#c4c8d0] text-[10.5px]"
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

        <div className="h-px bg-[#34343a]" />

        {/* Limit price field */}
        {mode === "limit" && (
          <div className="bg-[#26262b] border border-[#34343a] rounded-[9px] p-[12px] flex flex-col gap-2">
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
              <span className="flex items-center gap-1.5 text-[#e6e6e6] text-[14px] font-semibold shrink-0">
                <UsdcLogo size={15} /> USDC
              </span>
            </div>
          </div>
        )}

        {/* Order size field */}
        <div className="bg-[#26262b] border border-[#34343a] rounded-[9px] p-[12px] flex flex-col gap-2">
          <div className="flex items-center justify-between text-[12.5px] text-[#8a8f97]">
            <div className="flex items-center gap-[5px]">
              <span>Order Size</span>
    
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
            <button className="flex items-center gap-1.5 px-[10px] py-1 bg-[#1b1b1f] border border-[#34343a] rounded-[6px] text-[#e6e6e6] text-[13px] font-medium">
              {baseSymbol === "XLM" ? <XlmLogo size={15} /> : null} {baseSymbol} <span className="text-[#3fb27f]"><SwapIcon /></span>
            </button>
            <span className="font-mono text-[12px] text-[#5a5f66]">
              ${sizeNum > 0 && midPriceHuman !== null ? (sizeNum * midPriceHuman).toFixed(2) : "0.00"}
            </span>
          </div>
        </div>

        {/* Order leverage — inline slider */}
        <div className="bg-[#26262b] border border-[#34343a] rounded-[9px] px-[14px] py-[13px]">
          <div className="flex items-center justify-between mb-[10px]">
            <span className="flex items-center gap-[6px] text-[12.5px] text-[#8a8f97]">
              Order Leverage
              <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 7h8M8 12h2M12 12h2M16 12h.01M8 16h2M12 16h2M16 16h.01" />
              </svg>
            </span>
            <span className="font-mono text-[15px] font-medium text-[#f7931a]">{leverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={maxLev}
            step={1}
            value={leverage}
            onChange={(e) => setLeverage(Number(e.target.value))}
            className="w-full h-[4px] cursor-pointer accent-[#f7931a]"
            aria-label="Order leverage"
          />
          <div className="flex justify-between font-mono text-[11px] text-[#5a5f66] mt-[8px]">
            {levMarks.map((m) => (
              <button
                key={m}
                onClick={() => setLeverage(m)}
                className={`hover:text-[#e6e6e6] transition-colors ${leverage === m ? "text-[#f7931a]" : ""}`}
              >
                {m}x
              </button>
            ))}
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
            className="w-full py-[15px] rounded-[9px] text-[14px] font-semibold text-[#1a1205] transition-colors disabled:opacity-50"
            style={{ background: "#f7931a", letterSpacing: ".01em" }}
            onMouseOver={(e) => (e.currentTarget.style.background = "#ffa733")}
            onMouseOut={(e) => (e.currentTarget.style.background = "#f7931a")}
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
                : "bg-[#e8716f] hover:brightness-110"
            }`}
          >
            {loading
              ? "Placing…"
              : `Place ${side === "buy" ? "Long" : "Short"} ${mode === "limit" ? "Limit" : "Market"} Order`}
          </button>
        )}

        {/* Order summary */}
        <div className="flex flex-col gap-2 rounded-[9px] bg-[#26262b] p-[14px]">
          <div className={rowCls}>
            <span>{mode === "limit" ? "Limit Price" : "Expected Price"}</span>
            <span className="font-mono text-[#e6e6e6]">
              {mode === "limit"
                ? limitPriceNum > 0
                  ? `$${limitPriceNum.toFixed(4)}`
                  : "—"
                : midPriceHuman !== null
                ? `$${midDisplay}`
                : "—"}
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
          {mode === "market" && (
            <div className={rowCls}>
              <span>Slippage</span>
              <span className="flex items-center gap-[6px] font-mono text-[#e6e6e6]">
                Est: — / Max: 1% <PencilIcon />
              </span>
            </div>
          )}
          <div className={rowCls}>
            <span className="flex items-center gap-[5px]">
              Fees
              <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 11v5M12 8h.01" />
              </svg>
            </span>
            <span className="font-mono text-[#e6e6e6]">0.035% | 0.005%</span>
          </div>
        </div>
      </div>

      {/* Margin-mode popover */}
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
          checked ? "bg-[#f7931a] border-[#f7931a] text-[#1a1205]" : "bg-[#26262b] border-[#3f3f47]"
        }`}
      >
        {checked && <CheckIcon />}
      </div>
      {label}
    </button>
  );
}
