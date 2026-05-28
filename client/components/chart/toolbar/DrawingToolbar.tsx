"use client"

import type { DrawingToolType } from '../types'

interface Tool {
  key: DrawingToolType
  label: string
  icon: React.ReactNode
}

const TOOLS: Tool[] = [
  {
    key: 'pointer',
    label: 'Pointer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M5 3l14 9-7 2-3 7L5 3z" />
      </svg>
    ),
  },
  {
    key: 'trend',
    label: 'Trend Line',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M4 20L20 4" />
        <circle cx="4" cy="20" r="1.8" fill="currentColor" />
        <circle cx="20" cy="4" r="1.8" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'ray',
    label: 'Ray',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M4 20L22 2" />
        <circle cx="4" cy="20" r="1.8" fill="currentColor" />
        <path d="M18 4l4-2-2 4" fill="none" />
      </svg>
    ),
  },
  {
    key: 'extended',
    label: 'Extended Line',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M2 22L22 2" strokeDasharray="2 0" />
        <path d="M2 22L2 22" />
      </svg>
    ),
  },
  {
    key: 'hline',
    label: 'Horizontal Line',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M2 12h20" />
        <circle cx="2" cy="12" r="1.5" fill="currentColor" />
        <circle cx="22" cy="12" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'vline',
    label: 'Vertical Line',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M12 2v20" />
        <circle cx="12" cy="2" r="1.5" fill="currentColor" />
        <circle cx="12" cy="22" r="1.5" fill="currentColor" />
      </svg>
    ),
  },
  {
    key: 'rect',
    label: 'Rectangle',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <rect x="4" y="6" width="16" height="12" rx="1" />
      </svg>
    ),
  },
  {
    key: 'fib',
    label: 'Fib Retracement',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4}>
        <path d="M3 5h18M3 9h18M3 13h18M3 17h18M3 21h18" />
      </svg>
    ),
  },
  {
    key: 'arrow',
    label: 'Arrow',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M5 19L19 5" />
        <path d="M10 5h9v9" />
      </svg>
    ),
  },
  {
    key: 'text',
    label: 'Text',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M4 7V4h16v3M9 20h6M12 4v16" />
      </svg>
    ),
  },
  {
    key: 'position',
    label: 'Long/Short Position',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M3 12h18M3 7h8M3 17h8" />
        <path d="M15 5l4 2-4 2V5z" fill="currentColor" stroke="none" />
        <path d="M15 15l4 2-4 2v-4z" fill="currentColor" stroke="none" opacity={0.5} />
      </svg>
    ),
  },
  {
    key: 'ruler',
    label: 'Ruler / Measure',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6}>
        <path d="M3 17L17 3l4 4L7 21z" />
        <path d="M7 13l2 2M10 10l2 2M13 7l2 2" />
      </svg>
    ),
  },
]

const DIVIDER_AFTER: DrawingToolType[] = ['pointer', 'extended', 'vline', 'rect', 'ruler']

interface Props {
  activeTool: DrawingToolType
  onToolChange: (tool: DrawingToolType) => void
}

export function DrawingToolbar({ activeTool, onToolChange }: Props) {
  return (
    <div className="w-[46px] border-r border-[#1f232a] flex flex-col items-center py-[10px] gap-[1px] shrink-0 bg-[#0c0e12] overflow-y-auto">
      {TOOLS.map(({ key, label, icon }) => (
        <div key={key}>
          <button
            title={label}
            onClick={() => onToolChange(key)}
            className={`w-8 h-8 rounded-[6px] grid place-items-center transition-all duration-100 group relative ${
              activeTool === key
                ? 'bg-[#1c2030] text-[#5865f2] ring-1 ring-[#5865f2]/40'
                : 'text-[#5a5f67] hover:bg-[#14171c] hover:text-[#c4c8d0]'
            }`}
          >
            <div className="w-[17px] h-[17px]">{icon}</div>
            {/* Tooltip */}
            <span className="absolute left-[calc(100%+8px)] top-1/2 -translate-y-1/2 px-2 py-1 bg-[#1f232a] border border-[#2a2f37] text-[11px] text-[#c4c8d0] rounded whitespace-nowrap opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity z-50">
              {label}
            </span>
          </button>
          {DIVIDER_AFTER.includes(key) && (
            <div className="w-6 h-px bg-[#1f232a] my-[4px] mx-auto" />
          )}
        </div>
      ))}
    </div>
  )
}
