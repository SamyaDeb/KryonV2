"use client"

import {
  useEffect, useRef, useImperativeHandle, forwardRef, useCallback,
} from 'react'
import {
  createChart, ColorType, CrosshairMode, LineStyle,
  CandlestickSeries, LineSeries, HistogramSeries, BarSeries, AreaSeries,
  type IChartApi, type ISeriesApi, type Time, type SeriesType,
  type LogicalRange,
} from 'lightweight-charts'
import { useChartStore } from '@/store/chart'
import { useChartData } from '@/hooks/useChartData'
import { useMarketStore } from '@/store/market'
import { ema, sma, bollingerBands, rsi, macd } from '@/lib/indicators'
import { priceToHuman } from '@/lib/format'
import { TF_SECONDS } from '@/hooks/useChartData'
import type { IndicatorConfig } from './types'

export interface ChartHandle {
  chart: IChartApi
  mainSeries: ISeriesApi<SeriesType>
  containerEl: HTMLDivElement | null
  subRefs: React.RefObject<SubChartRef[]>
}

export interface SubChartRef {
  chart: IChartApi
  sync: (range: LogicalRange | null) => void
}

interface Props {
  symbol: string
  marketId: string
}

const CHART_BG = '#06070a'
const GRID_COLOR = '#161a20'
const TEXT_COLOR = '#8a8f97'
const AXIS_BORDER = '#1f232a'
const UP_COLOR = '#1fae5b'
const DOWN_COLOR = '#e34c4c'

export const ChartCore = forwardRef<ChartHandle, Props>(({ symbol, marketId }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const rsiContainerRef = useRef<HTMLDivElement>(null)
  const macdContainerRef = useRef<HTMLDivElement>(null)

  const chartRef = useRef<IChartApi | null>(null)
  const rsiChartRef = useRef<IChartApi | null>(null)
  const macdChartRef = useRef<IChartApi | null>(null)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mainSeriesRef = useRef<ISeriesApi<any> | null>(null)
  const volSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const indicatorSeriesRef = useRef<Map<string, ISeriesApi<any>>>(new Map())
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bbSeriesRef = useRef<[ISeriesApi<any>, ISeriesApi<any>, ISeriesApi<any>] | null>(null)
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdSeriesRef = useRef<{ line: ISeriesApi<'Line'>; sig: ISeriesApi<'Line'>; hist: ISeriesApi<'Histogram'> } | null>(null)

  const syncingRef = useRef(false)
  const subRefs = useRef<SubChartRef[]>([])

  // Live bar tracking state — persisted across oracle ticks within the same bar
  const liveBarRef = useRef<{ time: number; open: number; high: number; low: number; vol: number } | null>(null)

  const { timeframe, chartType, indicators } = useChartStore()
  const marketIdNum = parseInt(marketId, 10) || 1
  const rawMarkPrice = useMarketStore((s) => s.markPrices[marketIdNum])
  const { candles, isLoading } = useChartData({ symbol, timeframe, marketId: marketIdNum })

  // ── Create charts ─────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return
    const el = containerRef.current

    const sharedOpts = {
      layout: {
        background: { type: ColorType.Solid, color: CHART_BG },
        textColor: TEXT_COLOR,
        fontFamily: "'Inter', system-ui, sans-serif",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: GRID_COLOR },
        horzLines: { color: GRID_COLOR },
      },
      rightPriceScale: {
        borderColor: AXIS_BORDER,
        textColor: TEXT_COLOR,
      },
      timeScale: {
        borderColor: AXIS_BORDER,
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 14,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#2a2f38', labelBackgroundColor: '#1f232a', width: 1 as const },
        horzLine: { color: '#2a2f38', labelBackgroundColor: '#1f232a', width: 1 as const },
      },
    }

    const chart = createChart(el, {
      ...sharedOpts,
      autoSize: true,
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    })

    // Volume series
    const volSeries = chart.addSeries(HistogramSeries, {
      color: '#2a2d33',
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({
      scaleMargins: { top: 0.82, bottom: 0 },
    })

    chartRef.current = chart
    volSeriesRef.current = volSeries

    // RSI sub-chart
    if (rsiContainerRef.current) {
      const rsiChart = createChart(rsiContainerRef.current, {
        ...sharedOpts,
        autoSize: true,
        timeScale: { ...sharedOpts.timeScale, visible: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      })
      const rsiSeries = rsiChart.addSeries(LineSeries, {
        color: '#9b59b6',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: true,
      })
      // RSI levels
      rsiSeries.createPriceLine({ price: 70, color: '#e34c4c55', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false })
      rsiSeries.createPriceLine({ price: 30, color: '#1fae5b55', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false })
      rsiChartRef.current = rsiChart
      rsiSeriesRef.current = rsiSeries
      subRefs.current.push({
        chart: rsiChart,
        sync: (range) => {
          if (range && !syncingRef.current) {
            syncingRef.current = true
            rsiChart.timeScale().setVisibleLogicalRange(range)
            syncingRef.current = false
          }
        },
      })
    }

    // MACD sub-chart
    if (macdContainerRef.current) {
      const macdChart = createChart(macdContainerRef.current, {
        ...sharedOpts,
        autoSize: true,
        timeScale: { ...sharedOpts.timeScale, visible: false },
        handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
        handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      })
      const macdLine = macdChart.addSeries(LineSeries, { color: '#3b82f6', lineWidth: 1, priceLineVisible: false, lastValueVisible: true })
      const sigLine = macdChart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
      const histSeries = macdChart.addSeries(HistogramSeries, { color: '#3b82f666', priceScaleId: 'right', priceLineVisible: false })
      macdChartRef.current = macdChart
      macdSeriesRef.current = { line: macdLine, sig: sigLine, hist: histSeries }
      subRefs.current.push({
        chart: macdChart,
        sync: (range) => {
          if (range && !syncingRef.current) {
            syncingRef.current = true
            macdChart.timeScale().setVisibleLogicalRange(range)
            syncingRef.current = false
          }
        },
      })
    }

    // Sync time scales — in lightweight-charts v5, subscribeVisibleLogicalRangeChange
    // returns void; store handlers to pass to unsubscribeVisibleLogicalRangeChange.
    const rsiSyncHandler = (range: LogicalRange | null) => {
      if (!syncingRef.current && range) {
        syncingRef.current = true
        chartRef.current?.timeScale().setVisibleLogicalRange(range)
        syncingRef.current = false
      }
    }
    const macdSyncHandler = (range: LogicalRange | null) => {
      if (!syncingRef.current && range) {
        syncingRef.current = true
        chartRef.current?.timeScale().setVisibleLogicalRange(range)
        syncingRef.current = false
      }
    }
    rsiChartRef.current?.timeScale().subscribeVisibleLogicalRangeChange(rsiSyncHandler)
    macdChartRef.current?.timeScale().subscribeVisibleLogicalRangeChange(macdSyncHandler)

    return () => {
      rsiChartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(rsiSyncHandler)
      macdChartRef.current?.timeScale().unsubscribeVisibleLogicalRangeChange(macdSyncHandler)
      chart.remove()
      rsiChartRef.current?.remove()
      macdChartRef.current?.remove()
      chartRef.current = null
      rsiChartRef.current = null
      macdChartRef.current = null
      mainSeriesRef.current = null
      volSeriesRef.current = null
      rsiSeriesRef.current = null
      macdSeriesRef.current = null
      indicatorSeriesRef.current.clear()
      bbSeriesRef.current = null
      subRefs.current = []
    }
  }, []) // mount only

  // ── Sync sub-charts with main chart range ─────────────
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const handler = (range: LogicalRange | null) => {
      if (!syncingRef.current) {
        subRefs.current.forEach(r => r.sync(range))
      }
    }
    chart.timeScale().subscribeVisibleLogicalRangeChange(handler)
    return () => chart.timeScale().unsubscribeVisibleLogicalRangeChange(handler)
  }, [])

  // ── Rebuild main series when chart type changes ────────
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (mainSeriesRef.current) {
      chart.removeSeries(mainSeriesRef.current)
      mainSeriesRef.current = null
    }
    let series: ISeriesApi<SeriesType>
    if (chartType === 'bars') {
      series = chart.addSeries(BarSeries, {
        upColor: UP_COLOR, downColor: DOWN_COLOR,
        thinBars: false,
      })
    } else if (chartType === 'line') {
      series = chart.addSeries(LineSeries, { color: UP_COLOR, lineWidth: 2, priceLineVisible: true })
    } else if (chartType === 'area') {
      series = chart.addSeries(AreaSeries, {
        lineColor: UP_COLOR,
        topColor: `${UP_COLOR}44`,
        bottomColor: `${UP_COLOR}00`,
        lineWidth: 2,
      })
    } else {
      series = chart.addSeries(CandlestickSeries, {
        upColor: UP_COLOR, downColor: DOWN_COLOR,
        borderUpColor: UP_COLOR, borderDownColor: DOWN_COLOR,
        wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      })
    }
    mainSeriesRef.current = series
  }, [chartType])

  // ── Feed data into series ──────────────────────────────
  useEffect(() => {
    if (!mainSeriesRef.current || !volSeriesRef.current || candles.length === 0) return
    const ms = mainSeriesRef.current
    const vs = volSeriesRef.current

    if (chartType === 'line' || chartType === 'area') {
      ms.setData(candles.map(c => ({ time: c.time as Time, value: c.close })))
    } else {
      ms.setData(
        candles.map(c => ({ time: c.time as Time, open: c.open, high: c.high, low: c.low, close: c.close }))
      )
    }
    vs.setData(
      candles.map(c => ({
        time: c.time as Time,
        value: c.volume,
        color: c.close >= c.open ? `${UP_COLOR}44` : `${DOWN_COLOR}44`,
      }))
    )
  }, [candles, chartType])

  // ── Rebuild indicators whenever config or candles change ─
  const buildIndicators = useCallback((indicators: IndicatorConfig[]) => {
    const chart = chartRef.current
    if (!chart || candles.length === 0) return

    // Remove existing
    for (const s of indicatorSeriesRef.current.values()) {
      try { chart.removeSeries(s) } catch (_) { /* already gone */ }
    }
    indicatorSeriesRef.current.clear()
    if (bbSeriesRef.current) {
      bbSeriesRef.current.forEach(s => { try { chart.removeSeries(s) } catch (_) { /**/ } })
      bbSeriesRef.current = null
    }

    for (const ind of indicators) {
      if (!ind.visible) continue

      if (ind.type === 'EMA') {
        const d = ema(candles, ind.period ?? 20)
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false })
        s.setData(d.map(p => ({ time: p.time as Time, value: p.value })))
        indicatorSeriesRef.current.set(ind.id, s)
      } else if (ind.type === 'SMA') {
        const d = sma(candles, ind.period ?? 20)
        const s = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false })
        s.setData(d.map(p => ({ time: p.time as Time, value: p.value })))
        indicatorSeriesRef.current.set(ind.id, s)
      } else if (ind.type === 'BB') {
        const { upper, middle, lower } = bollingerBands(candles, ind.period ?? 20, ind.stdDev ?? 2)
        const u = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        const m = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, lineStyle: LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false })
        const l = chart.addSeries(LineSeries, { color: ind.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false })
        u.setData(upper.map(p => ({ time: p.time as Time, value: p.value })))
        m.setData(middle.map(p => ({ time: p.time as Time, value: p.value })))
        l.setData(lower.map(p => ({ time: p.time as Time, value: p.value })))
        bbSeriesRef.current = [u, m, l]
      }
    }
  }, [candles])

  useEffect(() => { buildIndicators(indicators) }, [indicators, buildIndicators])

  // ── RSI data ──────────────────────────────────────────
  useEffect(() => {
    const rsiInd = indicators.find(i => i.type === 'RSI' && i.visible)
    if (!rsiSeriesRef.current || candles.length === 0) return
    if (rsiInd) {
      const d = rsi(candles, rsiInd.period ?? 14)
      rsiSeriesRef.current.setData(d.map(p => ({ time: p.time as Time, value: p.value })))
    } else {
      rsiSeriesRef.current.setData([])
    }
  }, [indicators, candles])

  // ── MACD data ─────────────────────────────────────────
  useEffect(() => {
    const macdInd = indicators.find(i => i.type === 'MACD' && i.visible)
    if (!macdSeriesRef.current || candles.length === 0) return
    if (macdInd) {
      const { macdLine, signalLine, histogram } = macd(candles)
      macdSeriesRef.current.line.setData(macdLine.map(p => ({ time: p.time as Time, value: p.value })))
      macdSeriesRef.current.sig.setData(signalLine.map(p => ({ time: p.time as Time, value: p.value })))
      macdSeriesRef.current.hist.setData(
        histogram.map(p => ({ time: p.time as Time, value: p.value, color: p.value >= 0 ? '#3b82f666' : '#e34c4c66' }))
      )
    } else {
      macdSeriesRef.current.line.setData([])
      macdSeriesRef.current.sig.setData([])
      macdSeriesRef.current.hist.setData([])
    }
  }, [indicators, candles])

  // ── Live oracle price tick — update current bar without full re-render ──────
  useEffect(() => {
    if (!rawMarkPrice || candles.length === 0) return
    const ms = mainSeriesRef.current
    const vs = volSeriesRef.current
    if (!ms) return

    const price = priceToHuman(rawMarkPrice)
    const tfSec = TF_SECONDS[timeframe] ?? 3600
    const now = Math.floor(Date.now() / 1000)
    const barTime = Math.floor(now / tfSec) * tfSec

    const live = liveBarRef.current
    if (!live || live.time !== barTime) {
      const seed = live ? live.open : (candles[candles.length - 1]?.close ?? price)
      liveBarRef.current = { time: barTime, open: seed, high: price, low: price, vol: 0 }
    } else {
      live.high = Math.max(live.high, price)
      live.low = Math.min(live.low, price)
    }

    // Safe non-null: we just assigned above
    const bar = liveBarRef.current!
    try {
      if (chartType === 'line' || chartType === 'area') {
        ms.update({ time: barTime as Time, value: price })
      } else {
        ms.update({ time: barTime as Time, open: bar.open, high: bar.high, low: bar.low, close: price })
      }
      if (vs) {
        vs.update({ time: barTime as Time, value: bar.vol, color: price >= bar.open ? `${UP_COLOR}44` : `${DOWN_COLOR}44` })
      }
    } catch { /* series not ready */ }
  }, [rawMarkPrice]) // intentionally narrow dep — only trigger on new oracle price

  useImperativeHandle(ref, () => ({
    get chart() { return chartRef.current! },
    get mainSeries() { return mainSeriesRef.current! },
    get containerEl() { return containerRef.current },
    subRefs,
  }))

  const hasRSI = indicators.some(i => i.type === 'RSI' && i.visible)
  const hasMACD = indicators.some(i => i.type === 'MACD' && i.visible)

  // Always render the container divs so the chart instance can attach to them.
  // Show a loading overlay on top instead of replacing the DOM structure.
  return (
    <div className="w-full h-full flex flex-col">
      <div className="flex-1 min-h-0 relative">
        <div ref={containerRef} className="w-full h-full" />
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#06070a] z-10 pointer-events-none">
            <div className="flex flex-col items-center gap-3">
              <div className="w-5 h-5 border-2 border-[#1f232a] border-t-[#8a8f97] rounded-full animate-spin" />
              <span className="text-[#5a5f67] text-xs font-mono">Loading chart…</span>
            </div>
          </div>
        )}
      </div>
      {hasRSI && (
        <div className="shrink-0 border-t border-[#1a1e24]" style={{ height: 90 }}>
          <div className="px-2 pt-1">
            <span className="text-[10px] font-mono text-[#5a5f67]">RSI (14)</span>
          </div>
          <div ref={rsiContainerRef} style={{ height: 72 }} />
        </div>
      )}
      {hasMACD && (
        <div className="shrink-0 border-t border-[#1a1e24]" style={{ height: 90 }}>
          <div className="px-2 pt-1">
            <span className="text-[10px] font-mono text-[#5a5f67]">MACD (12, 26, 9)</span>
          </div>
          <div ref={macdContainerRef} style={{ height: 72 }} />
        </div>
      )}
    </div>
  )
})
ChartCore.displayName = 'ChartCore'
