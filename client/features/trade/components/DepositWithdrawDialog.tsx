"use client";

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { useWalletStore } from "@/stores/wallet";
import { deposit, withdraw, getBalance } from "@/lib/stellar/contracts";
import { humanToAmount, amountToHuman } from "@/lib/format";
import { ASSETS, STELLAR_EXPERT_URL } from "@/config";
import { UsdcLogo } from "@/components/common/AssetLogos";
import { toast } from "sonner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";

export function DepositWithdrawDialog({
  triggerLabel = "Deposit / Withdraw",
  triggerClassName = "h-7 text-xs rounded-[6px] border border-[#334155] bg-[#212128] hover:border-[#475569] text-[#f5f5f5] px-3 transition-colors",
  defaultTab = "deposit",
}: {
  triggerLabel?: string;
  triggerClassName?: string;
  defaultTab?: "deposit" | "withdraw";
} = {}) {
  const { address } = useWalletStore();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"deposit" | "withdraw">(defaultTab);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  const { data: balance } = useQuery({
    queryKey: ["balance", address],
    queryFn: () => getBalance(address!, ASSETS.usdc),
    enabled: !!address && open,
  });
  const balanceHuman = balance !== undefined ? amountToHuman(balance) : 0;

  function onAmount(v: string) {
    const cleaned = v.replace(/[^0-9.]/g, "");
    const parts = cleaned.split(".");
    setAmount(parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : cleaned);
  }

  async function run(kind: "deposit" | "withdraw") {
    if (!address || !amount) return;
    const parsedAmount = parseFloat(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      toast.error("Enter a valid amount");
      return;
    }
    const raw = humanToAmount(parsedAmount);
    setLoading(true);
    try {
      const res = kind === "deposit"
        ? await deposit(address, raw, ASSETS.usdc)
        : await withdraw(address, raw, ASSETS.usdc);
      toast.success(`${kind === "deposit" ? "Deposit" : "Withdrawal"} confirmed`, {
        action: {
          label: "Explorer",
          onClick: () =>
            window.open(`${STELLAR_EXPERT_URL}/tx/${(res as { hash?: string }).hash ?? ""}`, "_blank"),
        },
      });
      setAmount("");
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["balance", address] });
      queryClient.invalidateQueries({ queryKey: ["health", address] });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }

  const amt = parseFloat(amount) || 0;
  const overMax = tab === "withdraw" && amt > balanceHuman;
  const pill = (active: boolean) =>
    `rounded-[8px] py-2 text-[13px] font-semibold transition-colors ${
      active ? "bg-[#212128] text-[#f5f5f5]" : "text-[#a3a3a3] hover:text-[#f5f5f5]"
    }`;

  return (
    <>
      <button onClick={() => { setTab(defaultTab); setOpen(true); }} className={triggerClassName}>
        {triggerLabel}
      </button>

      {open && typeof document !== "undefined" &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setOpen(false)}
            />
            <div className="relative w-[380px] max-w-full rounded-xl border border-[#334155] bg-[#19191A] text-[#f5f5f5] shadow-[0_20px_60px_rgba(0,0,0,.6)]">
              <div className="p-5">
                {/* Header */}
                <div className="flex items-center justify-between">
                  <h2 className="text-[17px] font-bold text-[#f5f5f5]">Collateral</h2>
                  <button
                    onClick={() => setOpen(false)}
                    aria-label="Close"
                    className="w-7 h-7 grid place-items-center rounded-[6px] text-[#a3a3a3] hover:text-[#f5f5f5] hover:bg-[#212128] transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Tabs */}
                <div className="mt-4 grid grid-cols-2 gap-1 rounded-[10px] border border-[#334155] bg-[#212128] p-1">
                  <button className={pill(tab === "deposit")} onClick={() => setTab("deposit")}>Deposit</button>
                  <button className={pill(tab === "withdraw")} onClick={() => setTab("withdraw")}>Withdraw</button>
                </div>

                {/* Amount panel */}
                <div className="mt-4 rounded-[12px] border border-[#334155] bg-[#212128] p-4">
                  <div className="mb-2 flex items-center justify-between text-[12px] text-[#a3a3a3]">
                    <span>Amount</span>
                    {tab === "withdraw" && (
                      <div className="flex items-center gap-2 text-[11.5px]">
                        <button
                          onClick={() => setAmount((balanceHuman / 2).toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          50%
                        </button>
                        <button
                          onClick={() => setAmount(balanceHuman.toFixed(2))}
                          className="rounded-full bg-[#212128] border border-[#334155] px-2.5 py-0.5 font-semibold text-[#a3a3a3] hover:text-[#f5f5f5] transition-colors"
                        >
                          Max
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <input
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => onAmount(e.target.value)}
                      className="flex-1 min-w-0 bg-transparent outline-none border-0 text-[26px] font-semibold text-[#f5f5f5] tabular"
                    />
                    <span className="flex shrink-0 items-center gap-1.5 text-[15px] font-semibold text-[#f5f5f5]">
                      <UsdcLogo size={18} /> USDC
                    </span>
                  </div>
                </div>

                {/* Balance row */}
                <div className="mt-3 flex items-center justify-between px-1 text-[12.5px]">
                  <span className="text-[#a3a3a3]">
                    {tab === "deposit" ? "Vault balance" : "Available to withdraw"}
                  </span>
                  <span className="flex items-center gap-1.5 tabular text-[#f5f5f5]">
                    <UsdcLogo size={12} />
                    {balance === undefined ? "—" : `$${balanceHuman.toFixed(2)}`}
                  </span>
                </div>

                {/* Primary */}
                <button
                  onClick={() => run(tab)}
                  disabled={loading || !amount || amt <= 0 || overMax}
                  className="mt-5 w-full h-12 rounded-[10px] text-[14px] font-bold text-[#19191A] bg-[#e2a9f1] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {loading ? "Confirming…" : overMax ? "Insufficient balance" : tab === "deposit" ? "Deposit USDC" : "Withdraw USDC"}
                </button>

                <p className="mt-3 text-[11px] text-[#737373] text-center">
                  Signed via Freighter and submitted to Stellar testnet.
                </p>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
