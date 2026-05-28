"use client"

import { useEffect, useRef, useState } from 'react'
import { useChartStore } from '@/store/chart'
import type { IndicatorType, IndicatorConfig } from '../types'

interface IndicatorDef {
  type: IndicatorType
  label: string
  description: string
  defaultPeriod?: number
  defaultColor: string
  hasStdDev?: boolean
  subChart?: boolean
}

const INDICATOR_DEFS: IndicatorDef[] = [
  { type: 'EMA', label: 'EMA', description: 'Exponential Moving Average', defaultPeriod: 20, defaultColor: '#f59e0b' },
  { type: 'SMA', label: 'SMA', description: 'Simple Moving Average', defaultPeriod: 20, defaultColor: '#3b82f6' },
  { type: 'BB', label: 'Bollinger Bands', description: 'Bollinger Bands (20, 2)', defaultPeriod: 20, defaultColor: '#9b59b6', hasStdDev: true },
  { type: 'RSI', label: 'RSI', description: 'Relative Strength Index', defaultPeriod: 14, defaultColor: '#9b59b6', subChart: true },
  { type: 'MACD', label: 'MACD', description: 'Moving Average Convergence Divergence', defaultColor: '#3b82f6', subChart: true },
  { type: 'Volume', label: 'Volume', description: 'Trading Volume', defaultColor: '#3a3d42' },
]

interface Props {
  open: boolean
  onClose: () => void
}

export function IndicatorModal({ open, onClose }: Props) {
  const { indicators, addIndicator, removeIndicator, toggleIndicator } = useChartStore()
  const [search, setSearch] = useState('')
  const backdropRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const filtered = INDICATOR_DEFS.filter(
    d => d.label.toLowerCase().includes(search.toLowerCase()) ||
         d.description.toLowerCase().includes(search.toLowerCase())
  )

  const isActive = (type: IndicatorType) => indicators.some(i => i.type === type && i.visible)
  const exists = (type: IndicatorType) => indicators.some(i => i.type === type)

  function toggle(def: IndicatorDef) {
    const existing = indicators.find(i => i.type === def.type)
    if (existing) {
      toggleIndicator(existing.id)
    } else {
      addIndicator({
        id: `${def.type.toLowerCase()}_${Date.now()}`,
        type: def.type,
        period: def.defaultPeriod,
        stdDev: def.hasStdDev ? 2 : undefined,
        color: def.defaultColor,
        visible: true,
      } as IndicatorConfig)
    }
  }

  function removeAll(type: IndicatorType) {
    const toRemove = indicators.filter(i => i.type === type)
    toRemove.forEach(i => removeIndicator(i.id))
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose() }}
    >
      <div className="w-[460px] max-h-[520px] flex flex-col bg-[#0f1217] border border-[#1f232a] rounded-xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1f232a]">
          <span className="text-[13px] font-medium text-[#e2e4e9]">Indicators</span>
          <button onClick={onClose} className="text-[#5a5f67] hover:text-[#c4c8d0] transition-colors">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} width={14} height={14}>
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-[#1f232a]">
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#14171c] border border-[#1f232a]">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} width={13} height={13} className="text-[#5a5f67]">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M11 11l2.5 2.5" />
            </svg>
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search indicators…"
              className="flex-1 bg-transparent text-[12px] text-[#c4c8d0] placeholder-[#5a5f67] outline-none"
            />
          </div>
        </div>

        {/* Active indicators */}
        {indicators.length > 0 && !search && (
          <div className="px-4 py-3 border-b border-[#1f232a]">
            <p className="text-[10px] font-medium uppercase tracking-wider text-[#5a5f67] mb-2">Active</p>
            <div className="flex flex-wrap gap-2">
              {indicators.map(ind => (
                <div
                  key={ind.id}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[#14171c] border border-[#1f232a]"
                >
                  <div className="w-2 h-2 rounded-full" style={{ background: ind.color }} />
                  <span className="text-[11px] text-[#c4c8d0]">{ind.type}{ind.period ? ` (${ind.period})` : ''}</span>
                  <button
                    onClick={() => toggleIndicator(ind.id)}
                    className={`transition-colors ${ind.visible ? 'text-[#5a5f67] hover:text-[#c4c8d0]' : 'text-[#5865f2]'}`}
                    title={ind.visible ? 'Hide' : 'Show'}
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} width={11} height={11}>
                      {ind.visible
                        ? <><circle cx="7" cy="7" r="2" /><path d="M1 7c2-4 8-4 10 0-2 4-8 4-10 0z" /></>
                        : <><path d="M1 1l12 12M4 4C2 5.5 1 7 1 7c2 4 8 4 10 0" /><path d="M10 10c1.5-1 2-3 2-3" /></>
                      }
                    </svg>
                  </button>
                  <button
                    onClick={() => removeAll(ind.type)}
                    className="text-[#5a5f67] hover:text-[#e34c4c] transition-colors"
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} width={10} height={10}>
                      <path d="M2 2l10 10M12 2L2 12" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Indicator list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.map(def => {
            const active = isActive(def.type)
            const has = exists(def.type)
            return (
              <button
                key={def.type}
                onClick={() => toggle(def)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-[#14171c] transition-colors border-b border-[#1f232a]/50 last:border-0"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: `${def.defaultColor}22` }}
                  >
                    <div className="w-2 h-2 rounded-full" style={{ background: def.defaultColor }} />
                  </div>
                  <div className="text-left">
                    <div className="text-[12px] font-medium text-[#c4c8d0]">{def.label}</div>
                    <div className="text-[11px] text-[#5a5f67]">{def.description}</div>
                  </div>
                  {def.subChart && (
                    <span className="px-[6px] py-[2px] rounded bg-[#1f232a] text-[10px] text-[#5a5f67]">sub</span>
                  )}
                </div>
                <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${
                  active ? 'border-[#5865f2] bg-[#5865f2]' : has ? 'border-[#5a5f67] bg-transparent' : 'border-[#2a2f37] bg-transparent'
                }`}>
                  {active && (
                    <svg viewBox="0 0 10 10" fill="none" stroke="white" strokeWidth={1.8} width={8} height={8}>
                      <path d="M2 5l2 2 4-4" />
                    </svg>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
