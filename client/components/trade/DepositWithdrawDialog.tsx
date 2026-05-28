"use client";

import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWalletStore } from "@/store/wallet";
import { deposit, withdraw } from "@/lib/stellar/contracts";
import { humanToAmount, amountToHuman } from "@/lib/format";
import { ASSETS, STELLAR_EXPERT_URL } from "@/lib/config";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

export function DepositWithdrawDialog() {
  const { address } = useWalletStore();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleDeposit() {
    if (!address || !amount) return;
    const raw = humanToAmount(parseFloat(amount));
    setLoading(true);
    try {
      const res = await deposit(address, raw, ASSETS.usdc);
      toast.success("Deposit confirmed", {
        action: {
          label: "Explorer",
          onClick: () => window.open(`${STELLAR_EXPERT_URL}/tx/${(res as { hash?: string }).hash ?? ""}`, "_blank"),
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

  async function handleWithdraw() {
    if (!address || !amount) return;
    const raw = humanToAmount(parseFloat(amount));
    setLoading(true);
    try {
      const res = await withdraw(address, raw, ASSETS.usdc);
      toast.success("Withdrawal confirmed", {
        action: {
          label: "Explorer",
          onClick: () => window.open(`${STELLAR_EXPERT_URL}/tx/${(res as { hash?: string }).hash ?? ""}`, "_blank"),
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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <button className="h-7 text-xs rounded border border-[#1e2a3a] bg-[#1a2235] hover:bg-[#1e2a3a] text-slate-300 px-3 transition-colors">
            Deposit / Withdraw
          </button>
        }
      />
      <DialogContent className="bg-[#111722] border-[#1e2a3a] text-slate-200 max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-slate-100">Collateral</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="deposit">
          <TabsList className="w-full bg-[#0d1117] border border-[#1e2a3a]">
            <TabsTrigger value="deposit" className="flex-1 text-xs">Deposit USDC</TabsTrigger>
            <TabsTrigger value="withdraw" className="flex-1 text-xs">Withdraw USDC</TabsTrigger>
          </TabsList>

          <TabsContent value="deposit" className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Amount (USDC)</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="bg-[#0d1117] border-[#1e2a3a] text-slate-200 text-sm tabular"
              />
            </div>
            <Button
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold"
              onClick={handleDeposit}
              disabled={loading || !amount || parseFloat(amount) <= 0}
            >
              {loading ? "Confirming…" : "Deposit"}
            </Button>
          </TabsContent>

          <TabsContent value="withdraw" className="space-y-4 mt-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-400">Amount (USDC)</Label>
              <Input
                type="number"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="bg-[#0d1117] border-[#1e2a3a] text-slate-200 text-sm tabular"
              />
            </div>
            <Button
              variant="outline"
              className="w-full border-[#1e2a3a] bg-[#1a2235] hover:bg-[#1e2a3a] text-slate-200 font-semibold"
              onClick={handleWithdraw}
              disabled={loading || !amount || parseFloat(amount) <= 0}
            >
              {loading ? "Confirming…" : "Withdraw"}
            </Button>
          </TabsContent>
        </Tabs>

        <p className="text-[10px] text-slate-600 mt-1">
          Transactions are signed via Freighter and submitted to Stellar testnet.
        </p>
      </DialogContent>
    </Dialog>
  );
}
