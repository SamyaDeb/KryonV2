"use client"

import {
  useEffect, useRef, useCallback, useState, type MouseEvent,
} from 'react'
import type { IChartApi, ISeriesApi, SeriesType, Time } from 'lightweight-charts'
import { useDrawingStore } from '@/store/drawings'
import type {
  Drawing, DrawingToolType, PTP,
  TrendLine, RayLine, ExtendedLine, HLine, VLine,
  RectShape, FibShape, TextLabel, ArrowLine, PositionShape, RulerShape,
} from './types'

interface Props {
  chart: IChartApi | null
  mainSeries: ISeriesApi<SeriesType> | null
  containerEl: HTMLDivElement | null
  activeTool: DrawingToolType
  marketId: string
  onToolComplete?: () => void
}

const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
const ACCENT = '#5865f2'

function uid() {
  return Math.random().toString(36).slice(2, 9)
}

function toolColor(tool: DrawingToolType): string {
  const map: Partial<Record<DrawingToolType, string>> = {
    trend: '#e6e6e6', ray: '#e6e6e6', extended: '#e6e6e6',
    hline: '#f59e0b', vline: '#3b82f6',
    fib: '#9b59b6', rect: '#3b82f6',
    arrow: '#e6e6e6', position: '#1fae5b',
    ruler: '#8a8f97',
  }
  return map[tool] ?? '#e6e6e6'
}

function getCursor(tool: DrawingToolType): string {
  if (tool === 'pointer') return 'default'
  if (tool === 'text') return 'text'
  if (tool === 'erase') return 'not-allowed'
  return 'crosshair'
}

// ── Coordinate helpers ───────────────────────────────────
function toScreen(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  p: PTP
): { x: number; y: number } | null {
  const x = chart.timeScale().timeToCoordinate(p.time as Time)
  const y = series.priceToCoordinate(p.price)
  if (x == null || y == null) return null
  return { x, y }
}

function toWorld(
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  x: number, y: number
): PTP | null {
  const time = chart.timeScale().coordinateToTime(x)
  const price = series.coordinateToPrice(y)
  if (time == null || price == null) return null
  return { time: time as number, price }
}

// ── Canvas renderer ──────────────────────────────────────
function renderHandle(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  ctx.beginPath()
  ctx.arc(x, y, 5, 0, Math.PI * 2)
  ctx.fillStyle = ACCENT
  ctx.fill()
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1.5
  ctx.stroke()
}

function drawLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

function extendToEdge(
  x1: number, y1: number, x2: number, y2: number, w: number, h: number
): [number, number] {
  const dx = x2 - x1
  const dy = y2 - y1
  if (dx === 0) return [x2, dy > 0 ? h : 0]
  const slope = dy / dx
  const candidates: [number, number][] = [
    [w, y1 + slope * (w - x1)],
    [0, y1 + slope * (0 - x1)],
  ]
  for (const [cx, cy] of candidates) {
    if (cy >= -1 && cy <= h + 1) return [cx, cy]
  }
  return [x2, y2]
}

function renderDrawing(
  ctx: CanvasRenderingContext2D,
  d: Drawing,
  chart: IChartApi,
  series: ISeriesApi<SeriesType>,
  w: number, h: number,
) {
  if (d.hidden) return
  ctx.save()
  ctx.strokeStyle = d.color
  ctx.lineWidth = d.lineWidth
  ctx.setLineDash([])
  ctx.globalAlpha = 1

  switch (d.type) {
    case 'trend': case 'ray': case 'extended': case 'arrow': {
      const s1 = toScreen(chart, series, d.p1)
      const s2 = toScreen(chart, series, d.p2)
      if (!s1 || !s2) break
      let [ex2, ey2] = [s2.x, s2.y]
      if (d.type === 'ray' || d.type === 'extended') {
        ;[ex2, ey2] = extendToEdge(s1.x, s1.y, s2.x, s2.y, w, h)
      }
      if (d.type === 'arrow') {
        const angle = Math.atan2(s2.y - s1.y, s2.x - s1.x)
        drawLine(ctx, s1.x, s1.y, s2.x, s2.y)
        ctx.beginPath()
        ctx.moveTo(s2.x, s2.y)
        ctx.lineTo(s2.x - 10 * Math.cos(angle - 0.4), s2.y - 10 * Math.sin(angle - 0.4))
        ctx.moveTo(s2.x, s2.y)
        ctx.lineTo(s2.x - 10 * Math.cos(angle + 0.4), s2.y - 10 * Math.sin(angle + 0.4))
        ctx.stroke()
      } else {
        drawLine(ctx, s1.x, s1.y, ex2, ey2)
      }
      if (d.selected) { renderHandle(ctx, s1.x, s1.y, d.color); renderHandle(ctx, s2.x, s2.y, d.color) }
      break
    }

    case 'hline': {
      const y = series.priceToCoordinate(d.price)
      if (y == null) break
      ctx.setLineDash([6, 4])
      drawLine(ctx, 0, y, w, y)
      ctx.setLineDash([])
      if (d.label) {
        ctx.font = '11px Inter, system-ui, sans-serif'
        ctx.fillStyle = d.color
        ctx.fillText(d.label, 6, y - 4)
      }
      if (d.selected) { renderHandle(ctx, 20, y, d.color); renderHandle(ctx, w - 20, y, d.color) }
      break
    }

    case 'vline': {
      const x = chart.timeScale().timeToCoordinate(d.time as Time)
      if (x == null) break
      ctx.setLineDash([6, 4])
      drawLine(ctx, x, 0, x, h)
      ctx.setLineDash([])
      break
    }

    case 'rect': {
      const s1 = toScreen(chart, series, d.p1)
      const s2 = toScreen(chart, series, d.p2)
      if (!s1 || !s2) break
      const rx = Math.min(s1.x, s2.x), ry = Math.min(s1.y, s2.y)
      const rw = Math.abs(s2.x - s1.x), rh = Math.abs(s2.y - s1.y)
      ctx.globalAlpha = d.fillOpacity
      ctx.fillStyle = d.color
      ctx.fillRect(rx, ry, rw, rh)
      ctx.globalAlpha = 1
      ctx.strokeRect(rx, ry, rw, rh)
      break
    }

    case 'fib': {
      const s1 = toScreen(chart, series, d.p1)
      const s2 = toScreen(chart, series, d.p2)
      if (!s1 || !s2) break
      const priceRange = d.p2.price - d.p1.price
      const xLeft = Math.min(s1.x, s2.x)
      const xRight = Math.max(s1.x, s2.x)
      for (const lvl of FIB_LEVELS) {
        const price = d.p1.price + priceRange * lvl
        const yy = series.priceToCoordinate(price)
        if (yy == null) continue
        ctx.globalAlpha = 0.7
        ctx.setLineDash(lvl === 0 || lvl === 1 ? [] : [4, 3])
        drawLine(ctx, xLeft, yy, xRight, yy)
        ctx.setLineDash([])
        ctx.globalAlpha = 1
        ctx.font = '10px Inter, system-ui, sans-serif'
        ctx.fillStyle = d.color
        ctx.fillText(`${(lvl * 100).toFixed(1)}%  ${price.toFixed(4)}`, xRight + 5, yy + 4)
      }
      if (d.selected) {
        renderHandle(ctx, s1.x, s1.y, d.color)
        renderHandle(ctx, s2.x, s2.y, d.color)
      }
      break
    }

    case 'text': {
      const sp = toScreen(chart, series, d.point)
      if (!sp) break
      ctx.font = `${d.fontSize}px Inter, system-ui, sans-serif`
      ctx.fillStyle = d.color
      ctx.fillText(d.text, sp.x, sp.y)
      break
    }

    case 'position': {
      const entryY = series.priceToCoordinate(d.entryPrice)
      const targetY = series.priceToCoordinate(d.targetPrice)
      const stopY = series.priceToCoordinate(d.stopPrice)
      const entryX = chart.timeScale().timeToCoordinate(d.entryTime as Time)
      if (entryY == null || entryX == null) break
      const isLong = d.direction === 'long'
      const profitC = '#1fae5b', lossC = '#e34c4c'
      if (targetY != null) {
        ctx.fillStyle = isLong ? `${profitC}22` : `${lossC}22`
        ctx.fillRect(entryX, Math.min(entryY, targetY), w - entryX, Math.abs(entryY - targetY))
        ctx.strokeStyle = isLong ? profitC : lossC
        ctx.lineWidth = 1
        ctx.setLineDash([5, 3])
        drawLine(ctx, entryX, targetY, w, targetY)
        ctx.setLineDash([])
        ctx.font = '11px Inter'
        ctx.fillStyle = isLong ? profitC : lossC
        ctx.fillText(`TP  ${d.targetPrice.toFixed(4)}`, entryX + 4, targetY - 4)
      }
      if (stopY != null) {
        ctx.fillStyle = isLong ? `${lossC}22` : `${profitC}22`
        ctx.fillRect(entryX, Math.min(entryY, stopY), w - entryX, Math.abs(entryY - stopY))
        ctx.strokeStyle = isLong ? lossC : profitC
        ctx.lineWidth = 1
        ctx.setLineDash([5, 3])
        drawLine(ctx, entryX, stopY, w, stopY)
        ctx.setLineDash([])
        ctx.font = '11px Inter'
        ctx.fillStyle = isLong ? lossC : profitC
        ctx.fillText(`SL  ${d.stopPrice.toFixed(4)}`, entryX + 4, stopY - 4)
      }
      // Entry line
      ctx.strokeStyle = '#ffffff99'
      ctx.lineWidth = 1.5
      ctx.setLineDash([])
      drawLine(ctx, entryX, entryY, w, entryY)
      ctx.font = '11px Inter'
      ctx.fillStyle = '#ffffffcc'
      ctx.fillText(`Entry  ${d.entryPrice.toFixed(4)}`, entryX + 4, entryY - 4)
      break
    }

    case 'ruler': {
      const s1 = toScreen(chart, series, d.p1)
      const s2 = toScreen(chart, series, d.p2)
      if (!s1 || !s2) break
      ctx.setLineDash([4, 3])
      drawLine(ctx, s1.x, s1.y, s2.x, s2.y)
      ctx.setLineDash([])
      const pctChange = ((d.p2.price - d.p1.price) / d.p1.price) * 100
      const midX = (s1.x + s2.x) / 2
      const midY = (s1.y + s2.y) / 2
      ctx.font = '11px Inter, system-ui, sans-serif'
      ctx.fillStyle = d.color
      ctx.fillText(`${pctChange >= 0 ? '+' : ''}${pctChange.toFixed(2)}%`, midX, midY - 8)
      renderHandle(ctx, s1.x, s1.y, d.color)
      renderHandle(ctx, s2.x, s2.y, d.color)
      break
    }

    default:
      break
  }
  ctx.restore()
}

// ── Preview renderer (in-progress drawing) ───────────────
function renderPreview(
  ctx: CanvasRenderingContext2D,
  tool: DrawingToolType,
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  color: string,
  w: number, h: number,
) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.setLineDash([5, 4])
  ctx.globalAlpha = 0.8

  switch (tool) {
    case 'trend': case 'arrow':
      drawLine(ctx, p1.x, p1.y, p2.x, p2.y)
      break
    case 'ray': case 'extended': {
      const [ex, ey] = extendToEdge(p1.x, p1.y, p2.x, p2.y, w, h)
      drawLine(ctx, p1.x, p1.y, ex, ey)
      break
    }
    case 'hline':
      drawLine(ctx, 0, p1.y, w, p1.y)
      break
    case 'vline':
      drawLine(ctx, p1.x, 0, p1.x, h)
      break
    case 'rect': {
      const rx = Math.min(p1.x, p2.x), ry = Math.min(p1.y, p2.y)
      ctx.strokeRect(rx, ry, Math.abs(p2.x - p1.x), Math.abs(p2.y - p1.y))
      break
    }
    case 'fib': case 'position': case 'ruler':
      drawLine(ctx, p1.x, p1.y, p2.x, p2.y)
      break
  }

  ctx.setLineDash([])
  ctx.globalAlpha = 1
  renderHandle(ctx, p1.x, p1.y, color)
  ctx.restore()
}

// ── Component ────────────────────────────────────────────
export function DrawingOverlay({ chart, mainSeries, containerEl, activeTool, marketId, onToolComplete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const interactionRef = useRef<HTMLDivElement>(null)
  const drawState = useRef<{ p1: PTP; screenP1: { x: number; y: number } } | null>(null)
  const mousePos = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | undefined>(undefined)

  const { getDrawings, addDrawing, deleteAll } = useDrawingStore()
  const drawings = getDrawings(marketId)

  // ── Canvas render ─────────────────────────────────────
  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !chart || !mainSeries) return
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    const dpr = window.devicePixelRatio || 1
    if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, rect.width, rect.height)

    for (const d of drawings) {
      renderDrawing(ctx, d, chart, mainSeries, rect.width, rect.height)
    }

    // Preview
    if (drawState.current && mousePos.current && activeTool !== 'pointer') {
      const s1 = drawState.current.screenP1
      const s2 = mousePos.current
      renderPreview(ctx, activeTool, s1, s2, toolColor(activeTool), rect.width, rect.height)
    }
  }, [chart, mainSeries, drawings, activeTool])

  const scheduleRender = useCallback(() => {
    cancelAnimationFrame(rafRef.current!)
    rafRef.current = requestAnimationFrame(render)
  }, [render])

  // Subscribe to chart viewport changes
  useEffect(() => {
    if (!chart) return
    const unsub = chart.timeScale().subscribeVisibleLogicalRangeChange(scheduleRender)
    return unsub
  }, [chart, scheduleRender])

  // Re-render on drawings/tool change
  useEffect(() => { scheduleRender() }, [drawings, activeTool, scheduleRender])

  // Resize observer
  useEffect(() => {
    if (!containerEl) return
    const ro = new ResizeObserver(scheduleRender)
    ro.observe(containerEl)
    return () => ro.disconnect()
  }, [containerEl, scheduleRender])

  // ── Mouse handlers ────────────────────────────────────
  const getWorldPos = useCallback((e: MouseEvent): PTP | null => {
    if (!chart || !mainSeries || !containerEl) return null
    const rect = containerEl.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    return toWorld(chart, mainSeries, x, y)
  }, [chart, mainSeries, containerEl])

  const getScreenPos = useCallback((e: MouseEvent): { x: number; y: number } | null => {
    if (!containerEl) return null
    const rect = containerEl.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [containerEl])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const sp = getScreenPos(e)
    if (sp) { mousePos.current = sp; scheduleRender() }
  }, [getScreenPos, scheduleRender])

  const handleClick = useCallback((e: MouseEvent) => {
    if (!chart || !mainSeries || !containerEl) return
    const wp = getWorldPos(e)
    const sp = getScreenPos(e)
    if (!wp || !sp) return

    // Single-point tools
    if (activeTool === 'hline') {
      addDrawing(marketId, {
        id: uid(), type: 'hline', price: wp.price,
        color: toolColor('hline'), lineWidth: 1, locked: false, hidden: false, selected: false,
      } as HLine)
      onToolComplete?.()
      return
    }
    if (activeTool === 'vline') {
      addDrawing(marketId, {
        id: uid(), type: 'vline', time: wp.time,
        color: toolColor('vline'), lineWidth: 1, locked: false, hidden: false, selected: false,
      } as VLine)
      onToolComplete?.()
      return
    }
    if (activeTool === 'text') {
      const text = window.prompt('Enter label text:') ?? ''
      if (!text.trim()) return
      addDrawing(marketId, {
        id: uid(), type: 'text', point: wp, text: text.trim(),
        color: '#e6e6e6', lineWidth: 1, fontSize: 13, locked: false, hidden: false, selected: false,
      } as TextLabel)
      onToolComplete?.()
      return
    }

    // Two-point tools
    if (!drawState.current) {
      drawState.current = { p1: wp, screenP1: sp }
    } else {
      const p1 = drawState.current.p1
      drawState.current = null

      if (activeTool === 'trend') {
        addDrawing(marketId, { id: uid(), type: 'trend', p1, p2: wp, color: toolColor('trend'), lineWidth: 1.5, locked: false, hidden: false, selected: false } as TrendLine)
      } else if (activeTool === 'ray') {
        addDrawing(marketId, { id: uid(), type: 'ray', p1, p2: wp, color: toolColor('ray'), lineWidth: 1.5, locked: false, hidden: false, selected: false } as RayLine)
      } else if (activeTool === 'extended') {
        addDrawing(marketId, { id: uid(), type: 'extended', p1, p2: wp, color: toolColor('extended'), lineWidth: 1.5, locked: false, hidden: false, selected: false } as ExtendedLine)
      } else if (activeTool === 'arrow') {
        addDrawing(marketId, { id: uid(), type: 'arrow', p1, p2: wp, color: toolColor('arrow'), lineWidth: 1.5, locked: false, hidden: false, selected: false } as ArrowLine)
      } else if (activeTool === 'rect') {
        addDrawing(marketId, { id: uid(), type: 'rect', p1, p2: wp, color: toolColor('rect'), lineWidth: 1, fillOpacity: 0.1, locked: false, hidden: false, selected: false } as RectShape)
      } else if (activeTool === 'fib') {
        addDrawing(marketId, { id: uid(), type: 'fib', p1, p2: wp, color: toolColor('fib'), lineWidth: 1, locked: false, hidden: false, selected: false } as FibShape)
      } else if (activeTool === 'ruler') {
        addDrawing(marketId, { id: uid(), type: 'ruler', p1, p2: wp, color: toolColor('ruler'), lineWidth: 1, locked: false, hidden: false, selected: false } as RulerShape)
      } else if (activeTool === 'position') {
        const range = Math.abs(wp.price - p1.price)
        addDrawing(marketId, {
          id: uid(), type: 'position',
          direction: wp.price > p1.price ? 'long' : 'short',
          entryPrice: p1.price,
          entryTime: p1.time,
          targetPrice: p1.price + range,
          stopPrice: p1.price - range * 0.5,
          color: toolColor('position'),
          lineWidth: 1, locked: false, hidden: false, selected: false,
        } as PositionShape)
      }
      onToolComplete?.()
    }
    scheduleRender()
  }, [activeTool, chart, mainSeries, containerEl, getWorldPos, getScreenPos, addDrawing, marketId, onToolComplete, scheduleRender])

  const handleRightClick = useCallback((e: MouseEvent) => {
    e.preventDefault()
    drawState.current = null
    scheduleRender()
  }, [scheduleRender])

  // Reset draw state when tool changes
  useEffect(() => { drawState.current = null }, [activeTool])

  const isDrawing = activeTool !== 'pointer'

  return (
    <>
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute', inset: 0,
          width: '100%', height: '100%',
          pointerEvents: 'none', zIndex: 10,
        }}
      />
      <div
        ref={interactionRef}
        style={{
          position: 'absolute', inset: 0, zIndex: 11,
          pointerEvents: isDrawing ? 'all' : 'none',
          cursor: getCursor(activeTool),
        }}
        onMouseMove={handleMouseMove}
        onClick={handleClick}
        onContextMenu={handleRightClick}
      />
    </>
  )
}
