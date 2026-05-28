"use client"

import { useRef, useState, useEffect, useCallback } from 'react'
import { LineStyle } from 'lightweight-charts'
import { useChartStore } from '@/store/chart'
import { useDrawingStore } from '@/store/drawings'
import { ChartCore, type ChartHandle } from './ChartCore'
import { DrawingOverlay } from './DrawingOverlay'
import { DrawingToolbar } from './toolbar/DrawingToolbar'
import { ChartTopBar } from './toolbar/ChartTopBar'
import { IndicatorModal } from './toolbar/IndicatorModal'
import type { PositionOverlay, OrderOverlay } from './types'

interface Props {
  symbol: string
  marketId: string
  position?: PositionOverlay
  orders?: OrderOverlay[]
}

export function KryonChart({ symbol, marketId, position, orders }: Props) {
  const chartHandleRef = useRef<ChartHandle>(null)
  const [chartReady, setChartReady] = useState(false)
  const priceLineRefs = useRef<ReturnType<NonNullable<ChartHandle['mainSeries']>['createPriceLine']>[]>([])

  const {
    timeframe, chartType, activeTool, priceMode, indicators, showIndicatorModal,
    setTimeframe, setChartType, setActiveTool, setPriceMode, setShowIndicatorModal,
  } = useChartStore()
  const { deleteAll } = useDrawingStore()
  const [utcTime, setUtcTime] = useState('')

  useEffect(() => {
    function tick() {
      const d = new Date()
      const pad = (n: number) => String(n).padStart(2, '0')
      setUtcTime(`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Detect when ChartCore has mounted and populated the handle ref
  useEffect(() => {
    // Poll briefly until ref is populated (happens after first useEffect in ChartCore)
    let tries = 0
    const id = setInterval(() => {
      if (chartHandleRef.current?.chart) {
        setChartReady(true)
        clearInterval(id)
      }
      if (++tries > 40) clearInterval(id)
    }, 50)
    return () => clearInterval(id)
  }, [])

  // ── Perps trading overlays via price lines ────────────
  useEffect(() => {
    const h = chartHandleRef.current
    if (!h?.mainSeries) return

    for (const pl of priceLineRefs.current) {
      try { h.mainSeries.removePriceLine(pl) } catch (_) { /**/ }
    }
    priceLineRefs.current = []

    if (!position) return

    const lines: typeof priceLineRefs.current = []
    const push = (line: typeof lines[number]) => lines.push(line)
    const ms = h.mainSeries

    push(ms.createPriceLine({
      price: position.entryPrice,
      color: position.side === 'long' ? '#1fae5b' : '#e34c4c',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: `Entry${position.leverage ? ` ${position.leverage}×` : ''}`,
    }))
    push(ms.createPriceLine({
      price: position.liquidationPrice,
      color: '#ff6b35',
      lineWidth: 1,
      lineStyle: LineStyle.Dotted,
      axisLabelVisible: true,
      title: 'Liq.',
    }))
    if (position.tpPrice != null) {
      push(ms.createPriceLine({ price: position.tpPrice, color: '#1fae5b', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'TP' }))
    }
    if (position.slPrice != null) {
      push(ms.createPriceLine({ price: position.slPrice, color: '#e34c4c', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL' }))
    }
    orders?.forEach(ord => {
      push(ms.createPriceLine({
        price: ord.price,
        color: ord.side === 'buy' ? '#1fae5b88' : '#e34c4c88',
        lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true,
        title: ord.label ?? `${ord.side.toUpperCase()} ${ord.size}`,
      }))
    })
    priceLineRefs.current = lines
  }, [chartReady, position, orders])

  const marketIdStr = String(marketId)
  const activeIndicatorCount = indicators.filter(i => i.visible).length

  const handle = chartHandleRef.current

  return (
    <div className="flex flex-col h-full overflow-hidden rounded-xl border border-[#1f232a] bg-[#06070a]">
      {/* Top bar */}
      <ChartTopBar
        timeframe={timeframe}
        chartType={chartType}
        priceMode={priceMode}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onPriceModeChange={setPriceMode}
        onOpenIndicators={() => setShowIndicatorModal(true)}
        indicatorCount={activeIndicatorCount}
      />

      {/* Chart body */}
      <div className="flex flex-1 min-h-0">
        <DrawingToolbar activeTool={activeTool} onToolChange={setActiveTool} />

        <div className="flex-1 min-w-0 min-h-0 relative">
          <ChartCore ref={chartHandleRef} symbol={symbol} marketId={marketIdStr} />
          {chartReady && handle?.chart && handle.mainSeries && (
            <DrawingOverlay
              chart={handle.chart}
              mainSeries={handle.mainSeries}
              containerEl={handle.containerEl}
              activeTool={activeTool}
              marketId={marketIdStr}
              onToolComplete={() => setActiveTool('pointer')}
            />
          )}
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-between px-4 py-[6px] border-t border-[#1f232a] shrink-0">
        <button
          onClick={() => deleteAll(marketIdStr)}
          className="flex items-center gap-1.5 px-[8px] py-[4px] rounded-[4px] text-[11px] text-[#3a3f47] hover:bg-[#14171c] hover:text-[#8a8f97] transition-colors"
        >
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} width={10} height={10}>
            <path d="M2 4h10M5 4V2h4v2M3 4l1 8h6l1-8" />
          </svg>
          Clear
        </button>
        <span className="text-[11px] font-mono text-[#3a3f47]">{utcTime}</span>
      </div>

      <IndicatorModal open={showIndicatorModal} onClose={() => setShowIndicatorModal(false)} />
    </div>
  )
}
