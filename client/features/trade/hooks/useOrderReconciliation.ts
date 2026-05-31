"use client";

import { useEffect } from "react";
import { useWalletStore } from "@/stores/wallet";
import { useLocalOrders } from "@/stores/orders";
import { getOrderFilled, isCancelled } from "@/lib/stellar/contracts";

const POLL_MS = 8_000;

/**
 * Keeps locally-tracked orders in sync with on-chain reality.
 *
 * A local order is added as "pending" the moment it's submitted. Without
 * reconciliation it would stay "pending" forever — even after it fills into a
 * position or is cancelled on-chain. This polls the gateway's per-(owner,nonce)
 * `filled` counter and `is_cancelled` flag and transitions local orders to
 * "filled" / "cancelled" so the Open Orders table reflects the truth (and a
 * filled order correctly disappears once its position shows up).
 */
export function useOrderReconciliation() {
  const address = useWalletStore((s) => s.address);
  const connected = useWalletStore((s) => s.connected);

  useEffect(() => {
    if (!address || !connected) return;
    const owner = address;
    let cancelled = false;

    async function reconcile() {
      const pending = useLocalOrders
        .getState()
        .orders.filter((o) => o.status === "pending" && o.owner === owner);
      if (pending.length === 0) return;

      // Bound work: reconcile the 20 most recent pending orders per tick.
      for (const o of pending.slice(0, 20)) {
        try {
          const [filled, canc] = await Promise.all([
            getOrderFilled(owner, o.nonce),
            isCancelled(owner, o.nonce),
          ]);
          if (cancelled) return;
          const store = useLocalOrders.getState();
          if (canc) {
            store.cancelOrder(o.nonce, owner);
          } else if (o.size > 0n && filled >= o.size) {
            store.markFilled(o.nonce, owner);
          }
        } catch {
          /* transient RPC error — retry next tick */
        }
      }
    }

    reconcile();
    const t = setInterval(reconcile, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [address, connected]);
}
