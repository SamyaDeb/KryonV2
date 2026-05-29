"use client"

import { useState, useRef, useEffect } from 'react'
import { Settings as SettingsIcon, Check } from 'lucide-react'
import { useTradeSettings, type SettingKey } from '@/stores/settings'

const ROWS: { key: SettingKey; label: string }[] = [
  { key: 'hidePnl', label: 'Hide PNL' },
  { key: 'hideLiqPrice', label: 'Hide Liquidation Price' },
  { key: 'animateOrderBook', label: 'Animate Order Book' },
  { key: 'skipOrderConfirms', label: 'Skip Order Confirmations' },
]

export function SettingsMenu() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const settings = useTradeSettings()

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        aria-label="Settings"
        onClick={() => setOpen((v) => !v)}
        className="w-[34px] h-[34px] grid place-items-center text-[#8a8f97] hover:text-[#e6e6e6] transition-colors"
      >
        <SettingsIcon size={15} />
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-[262px] rounded-[12px] border border-[#1f232a] bg-[#0f1217] shadow-[0_20px_40px_rgba(0,0,0,.6)] z-50 overflow-hidden">
          <div className="py-1">
            {ROWS.map((row) => (
              <button
                key={row.key}
                onClick={() => settings.toggle(row.key)}
                className="flex w-full items-center justify-between gap-3 px-4 py-[9px] text-left hover:bg-[#14171c] transition-colors"
              >
                <span className="text-[13px] text-[#8a8f97]">{row.label}</span>
                <span
                  className={`flex w-4 h-4 items-center justify-center rounded-[4px] border transition-colors ${
                    settings[row.key] ? 'border-[#f7931a] bg-[#f7931a]' : 'border-[#2a2f37] bg-transparent'
                  }`}
                >
                  {settings[row.key] && <Check size={10} strokeWidth={3.5} className="text-[#1a1205]" />}
                </span>
              </button>
            ))}
            <div className="my-1 h-px bg-[#1f232a]" />
            <button
              onClick={() => settings.reset()}
              className="w-full px-4 py-[9px] text-left text-[13px] font-medium text-[#f7931a] hover:brightness-110 transition"
            >
              Reset to Defaults
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
