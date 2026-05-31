"use client"

import { useState, useEffect, useRef } from 'react'
import { useChartStore } from '@/stores/chart'
import { ChartTopBar } from './ChartTopBar'
import { TradingViewWidget } from './TradingViewWidget'
import type { PositionOverlay, OrderOverlay } from '../types'

interface Props {
  symbol: string
  marketId: string
  position?: PositionOverlay
  orders?: OrderOverlay[]
}

// Kryon timeframe → TradingView interval
const TV_INTERVAL: Record<string, string> = {
  '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30',
  '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720',
  '1d': 'D', '1w': 'W',
}
// Kryon chart type → TradingView style
const TV_STYLE: Record<string, string> = {
  candles: '1', bars: '0', line: '2', area: '3',
}

export function KryonChart({ symbol }: Props) {
  const { timeframe, chartType, setTimeframe, setChartType } = useChartStore()
  const [utcTime, setUtcTime] = useState('')
  const shellRef = useRef<HTMLDivElement>(null)

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

  const tvInterval = TV_INTERVAL[timeframe] ?? '60'
  const tvStyle = TV_STYLE[chartType] ?? '1'

  const resetControls = () => {
    setTimeframe('1h')
    setChartType('candles')
  }

  const toggleFullscreen = async () => {
    if (typeof document === 'undefined') return
    if (document.fullscreenElement) {
      await document.exitFullscreen().catch(() => undefined)
      return
    }
    await shellRef.current?.requestFullscreen?.().catch(() => undefined)
  }

  return (
    <div ref={shellRef} className="flex flex-col h-full overflow-hidden rounded-none bg-[#19191A]">
      {/* Top bar — timeframe & chart type drive the TradingView widget */}
      <ChartTopBar
        timeframe={timeframe}
        chartType={chartType}
        onTimeframeChange={setTimeframe}
        onChartTypeChange={setChartType}
        onReset={resetControls}
        onFullscreen={toggleFullscreen}
      />

      {/* Chart body */}
      <div className="flex-1 min-h-0 relative">
        <TradingViewWidget symbol={symbol} interval={tvInterval} chartStyle={tvStyle} />
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-end px-4 py-[6px] shrink-0">
        <span className="text-[11px] font-mono text-[#525252]">{utcTime}</span>
      </div>
    </div>
  )
}
