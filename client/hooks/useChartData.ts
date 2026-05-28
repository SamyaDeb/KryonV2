"use client"

import { useState, useEffect, useRef } from 'react'
import { MATCHER_URL, INDEXER_URL } from '@/lib/config'
import type { OHLCV } from '@/lib/indicators'

export const TF_SECONDS: Record<string, number> = {
  '1m': 60,
  '3m': 180,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '2h': 7200,
  '4h': 14400,
  '6h': 21600,
  '12h': 43200,
  '1d': 86400,
  '1w': 604800,
}

// Binance public klines — no key needed, CORS open
const BINANCE_BASE = 'https://api.binance.com/api/v3/klines'

function symbolToBinancePair(symbol: string): string {
  const up = symbol.toUpperCase()
  if (up.includes('XLM')) return 'XLMUSDT'
  if (up.includes('BTC')) return 'BTCUSDT'
  if (up.includes('ETH')) return 'ETHUSDT'
  return 'XLMUSDT' // default
}

function parseBinanceKlines(raw: unknown[][]): OHLCV[] {
  return raw.map((r) => ({
    time: Math.floor(Number(r[0]) / 1000),
    open: parseFloat(r[1] as string),
    high: parseFloat(r[2] as string),
    low: parseFloat(r[3] as string),
    close: parseFloat(r[4] as string),
    volume: parseFloat(r[5] as string),
  }))
}

async function fetchFromMatcher(marketId: number, tf: number, limit: number): Promise<OHLCV[] | null> {
  if (!MATCHER_URL) return null
  try {
    const res = await fetch(`${MATCHER_URL}/markets/${marketId}/candles?tf=${tf}&limit=${limit}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const raw = await res.json() as Record<string, unknown>[]
    if (!Array.isArray(raw) || raw.length === 0) return null
    return raw.map((r) => ({
      time: Number(r['time'] ?? r['open_time']),
      open: parseFloat(String(r['open'])),
      high: parseFloat(String(r['high'])),
      low: parseFloat(String(r['low'])),
      close: parseFloat(String(r['close'])),
      volume: parseFloat(String(r['volume'] ?? 0)),
    }))
  } catch {
    return null
  }
}

async function fetchFromIndexer(marketId: number, tf: number, limit: number): Promise<OHLCV[] | null> {
  if (!INDEXER_URL) return null
  try {
    const res = await fetch(`${INDEXER_URL}/markets/${marketId}/candles?tf=${tf}&limit=${limit}`, {
      cache: 'no-store',
    })
    if (!res.ok) return null
    const raw = await res.json() as Record<string, unknown>[]
    if (!Array.isArray(raw) || raw.length === 0) return null
    return raw.map((r) => ({
      time: Number(r['time'] ?? r['open_time']),
      open: parseFloat(String(r['open'])),
      high: parseFloat(String(r['high'])),
      low: parseFloat(String(r['low'])),
      close: parseFloat(String(r['close'])),
      volume: parseFloat(String(r['volume'] ?? 0)),
    }))
  } catch {
    return null
  }
}

async function fetchFromBinance(symbol: string, interval: string, limit: number): Promise<OHLCV[]> {
  const pair = symbolToBinancePair(symbol)
  const url = `${BINANCE_BASE}?symbol=${pair}&interval=${interval}&limit=${limit}`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Binance ${res.status}`)
  const raw = await res.json() as unknown[][]
  return parseBinanceKlines(raw)
}

interface Options {
  symbol: string
  timeframe: string
  marketId?: number
}

export function useChartData({ symbol, timeframe, marketId = 1 }: Options) {
  const [candles, setCandles] = useState<OHLCV[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    let cancelled = false
    if (abortRef.current) abortRef.current.abort()
    abortRef.current = new AbortController()

    setIsLoading(true)
    setError(null)

    const tfSec = TF_SECONDS[timeframe] ?? 3600
    const limit = 600

    async function load() {
      // Minimum candles required from DB sources before trusting them;
      // a new DEX has very few fills so always fall through to Binance.
      const MIN_DB_CANDLES = 20

      try {
        // Always load Binance first as the historical base — it is always
        // available and has hundreds of candles. Overlay DB fills on top
        // if there are enough to be meaningful.
        const fromBinance = await fetchFromBinance(symbol, timeframe, limit)
        if (!cancelled && fromBinance.length > 0) {
          // Try to merge recent DB candles over the Binance data
          const fromMatcher = await fetchFromMatcher(marketId, tfSec, limit)
          if (!cancelled && fromMatcher && fromMatcher.length >= MIN_DB_CANDLES) {
            setCandles(fromMatcher)
            setIsLoading(false)
            return
          }
          setCandles(fromBinance)
          setIsLoading(false)
          return
        }

        // Binance unavailable — try DB sources
        const fromMatcher = await fetchFromMatcher(marketId, tfSec, limit)
        if (!cancelled && fromMatcher && fromMatcher.length > 0) {
          setCandles(fromMatcher)
          setIsLoading(false)
          return
        }

        const fromIndexer = await fetchFromIndexer(marketId, tfSec, limit)
        if (!cancelled && fromIndexer && fromIndexer.length > 0) {
          setCandles(fromIndexer)
          setIsLoading(false)
          return
        }

        // All sources exhausted with no data
        if (!cancelled) setIsLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(String(e))
          setIsLoading(false)
        }
      }
    }

    load()
    return () => { cancelled = true }
  }, [symbol, timeframe, marketId])

  return { candles, isLoading, error }
}
