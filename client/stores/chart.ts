"use client"

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Timeframe, ChartType, DrawingToolType, IndicatorConfig, PriceMode } from '@/features/chart/types'

const DEFAULT_INDICATORS: IndicatorConfig[] = [
  { id: 'vol', type: 'Volume', color: '#3a3d42', visible: true },
]

interface ChartStore {
  timeframe: Timeframe
  chartType: ChartType
  activeTool: DrawingToolType
  priceMode: PriceMode
  indicators: IndicatorConfig[]
  showIndicatorModal: boolean

  setTimeframe: (tf: Timeframe) => void
  setChartType: (type: ChartType) => void
  setActiveTool: (tool: DrawingToolType) => void
  setPriceMode: (mode: PriceMode) => void
  addIndicator: (config: IndicatorConfig) => void
  removeIndicator: (id: string) => void
  toggleIndicator: (id: string) => void
  updateIndicator: (id: string, updates: Partial<IndicatorConfig>) => void
  setShowIndicatorModal: (show: boolean) => void
}

export const useChartStore = create<ChartStore>()(
  persist(
    (set) => ({
      timeframe: '1h',
      chartType: 'candles',
      activeTool: 'pointer',
      priceMode: 'last',
      indicators: DEFAULT_INDICATORS,
      showIndicatorModal: false,

      setTimeframe: (tf) => set({ timeframe: tf }),
      setChartType: (type) => set({ chartType: type }),
      setActiveTool: (tool) => set({ activeTool: tool }),
      setPriceMode: (mode) => set({ priceMode: mode }),
      addIndicator: (config) => set(s => ({ indicators: [...s.indicators, config] })),
      removeIndicator: (id) => set(s => ({ indicators: s.indicators.filter(i => i.id !== id) })),
      toggleIndicator: (id) =>
        set(s => ({
          indicators: s.indicators.map(i => i.id === id ? { ...i, visible: !i.visible } : i),
        })),
      updateIndicator: (id, updates) =>
        set(s => ({
          indicators: s.indicators.map(i => i.id === id ? { ...i, ...updates } : i),
        })),
      setShowIndicatorModal: (show) => set({ showIndicatorModal: show }),
    }),
    { name: 'kryon-chart-v1' }
  )
)
