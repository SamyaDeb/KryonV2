"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type SettingKey = 'hidePnl' | 'hideLiqPrice' | 'animateOrderBook' | 'skipOrderConfirms'

interface TradeSettings {
  hidePnl: boolean
  hideLiqPrice: boolean
  animateOrderBook: boolean
  skipOrderConfirms: boolean
  toggle: (k: SettingKey) => void
  reset: () => void
}

const DEFAULTS = {
  hidePnl: false,
  hideLiqPrice: false,
  animateOrderBook: true,
  skipOrderConfirms: false,
}

export const useTradeSettings = create<TradeSettings>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      toggle: (k) => set((s) => ({ [k]: !s[k] }) as Partial<TradeSettings>),
      reset: () => set({ ...DEFAULTS }),
    }),
    { name: 'kryon-settings' }
  )
)
