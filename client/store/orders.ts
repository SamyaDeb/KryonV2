"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { OrderIntent } from "@/lib/orders/intent";

const bigIntStorage = createJSONStorage(() => localStorage, {
  replacer: (_key, value) => (typeof value === "bigint" ? `__bigint__${value}` : value),
  reviver: (_key, value) =>
    typeof value === "string" && value.startsWith("__bigint__")
      ? BigInt(value.slice(10))
      : value,
});

interface OrdersState {
  orders: (OrderIntent & { status: "pending" | "filled" | "cancelled" })[];
  addOrder: (intent: OrderIntent) => void;
  cancelOrder: (nonce: bigint) => void;
  markFilled: (nonce: bigint) => void;
}

export const useLocalOrders = create<OrdersState>()(
  persist(
    (set) => ({
      orders: [],
      addOrder: (intent) =>
        set((s) => ({
          orders: [
            { ...intent, status: "pending" as const },
            ...s.orders.slice(0, 99),
          ],
        })),
      cancelOrder: (nonce) =>
        set((s) => ({
          orders: s.orders.map((o) =>
            o.nonce === nonce ? { ...o, status: "cancelled" as const } : o
          ),
        })),
      markFilled: (nonce) =>
        set((s) => ({
          orders: s.orders.map((o) =>
            o.nonce === nonce ? { ...o, status: "filled" as const } : o
          ),
        })),
    }),
    {
      name: "kryon-orders",
      storage: bigIntStorage,
    }
  )
);
