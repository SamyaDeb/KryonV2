"use client"

import type { Timeframe, ChartType, PriceMode } from '../types'

const TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d']
const MORE_TFS: Timeframe[] = ['3m', '30m', '2h', '6h', '12h', '1w']

interface Props {
  timeframe: Timeframe
  chartType: ChartType
  priceMode: PriceMode
  onTimeframeChange: (tf: Timeframe) => void
  onChartTypeChange: (type: ChartType) => void
  onPriceModeChange: (mode: PriceMode) => void
  onOpenIndicators: () => void
  indicatorCount: number
}

const CHART_TYPE_ICONS: Record<ChartType, React.ReactNode> = {
  candles: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <rect x="5" y="5" width="3" height="8" />
      <path d="M6.5 3v2M6.5 13v2" />
      <rect x="10" y="3" width="3" height="8" />
      <path d="M11.5 1v2M11.5 11v2" />
    </svg>
  ),
  bars: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M5 3v12M5 6h-2M5 9h2M10 2v12M10 5h-2M10 10h2" />
    </svg>
  ),
  line: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M2 13L6 8l4 3 4-8" />
    </svg>
  ),
  area: (
    <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth={1.4} width={15} height={15}>
      <path d="M2 14L6 9l4 3 4-8L16 8v6z" fill="currentColor" fillOpacity={0.2} />
      <path d="M2 14L6 9l4 3 4-8L16 8" />
    </svg>
  ),
}

const CHART_TYPES: ChartType[] = ['candles', 'bars', 'line', 'area']

export function ChartTopBar({
  timeframe, chartType, priceMode,
  onTimeframeChange, onChartTypeChange, onPriceModeChange,
  onOpenIndicators, indicatorCount,
}: Props) {
  const tfCls = (active: boolean) =>
    `px-[9px] py-[5px] rounded-[5px] text-[12px] font-mono font-medium transition-colors ${
      active
        ? 'text-[#e2e4e9] bg-[#14171c]'
        : 'text-[#5a5f67] hover:text-[#c4c8d0]'
    }`

  const btnCls = 'flex items-center gap-[5px] px-[9px] py-[5px] rounded-[5px] text-[12px] text-[#5a5f67] hover:bg-[#14171c] hover:text-[#c4c8d0] transition-colors'

  return (
    <div className="flex items-center justify-between px-3 border-b border-[#1f232a] shrink-0" style={{ minHeight: 42 }}>
      {/* Left: timeframes + chart type + indicators */}
      <div className="flex items-center gap-[2px]">
        {/* Timeframes */}
        {TIMEFRAMES.map(tf => (
          <button key={tf} className={tfCls(tf === timeframe)} onClick={() => onTimeframeChange(tf)}>
            {tf}
          </button>
        ))}
        <div className="relative group">
          <button className={tfCls(MORE_TFS.includes(timeframe))}>
            {MORE_TFS.includes(timeframe) ? timeframe : '▾'}
          </button>
          <div className="absolute top-full left-0 mt-1 bg-[#12151a] border border-[#1f232a] rounded-lg p-1 z-50 opacity-0 group-hover:opacity-100 pointer-events-none group-hover:pointer-events-auto transition-opacity">
            {MORE_TFS.map(tf => (
              <button
                key={tf}
                className={`block w-full px-3 py-[5px] text-left text-[12px] font-mono rounded-[4px] transition-colors ${
                  tf === timeframe ? 'text-[#e2e4e9] bg-[#1f232a]' : 'text-[#5a5f67] hover:text-[#c4c8d0] hover:bg-[#14171c]'
                }`}
                onClick={() => onTimeframeChange(tf)}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>

        <div className="w-px h-[14px] bg-[#1f232a] mx-[4px]" />

        {/* Chart types */}
        <div className="flex items-center">
          {CHART_TYPES.map(ct => (
            <button
              key={ct}
              title={ct.charAt(0).toUpperCase() + ct.slice(1)}
              onClick={() => onChartTypeChange(ct)}
              className={`w-8 h-8 rounded-[5px] grid place-items-center transition-colors ${
                chartType === ct
                  ? 'bg-[#14171c] text-[#e2e4e9]'
                  : 'text-[#5a5f67] hover:bg-[#14171c] hover:text-[#c4c8d0]'
              }`}
            >
              {CHART_TYPE_ICONS[ct]}
            </button>
          ))}
        </div>

        <div className="w-px h-[14px] bg-[#1f232a] mx-[4px]" />

        {/* Indicators */}
        <button className={btnCls} onClick={onOpenIndicators}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} width={13} height={13}>
            <path d="M2 12l3-4 3 2 4-6 2 2" />
            <path d="M2 7h1M7 3h1" strokeDasharray="1 1" />
          </svg>
          Indicators
          {indicatorCount > 0 && (
            <span className="ml-1 px-[5px] py-[1px] rounded-full bg-[#5865f2]/20 text-[#5865f2] text-[10px] font-medium">
              {indicatorCount}
            </span>
          )}
        </button>
      </div>

      {/* Right: price mode toggle */}
      <div className="flex items-center gap-2">
        <div className="flex bg-[#0c0e12] border border-[#1f232a] rounded-[6px] p-[2px]">
          {(['last', 'mark'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => onPriceModeChange(mode)}
              className={`px-[10px] py-[4px] rounded-[4px] text-[11.5px] font-medium transition-colors ${
                priceMode === mode
                  ? 'bg-[#1f232a] text-[#e2e4e9]'
                  : 'text-[#5a5f67] hover:text-[#c4c8d0]'
              }`}
            >
              {mode === 'last' ? 'Last' : 'Mark'}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
