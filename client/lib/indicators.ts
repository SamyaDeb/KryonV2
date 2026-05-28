export interface OHLCV {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Point {
  time: number
  value: number
}

export function ema(data: OHLCV[], period: number): Point[] {
  if (data.length < period) return []
  const k = 2 / (period + 1)
  const result: Point[] = []
  let val = data.slice(0, period).reduce((s, d) => s + d.close, 0) / period
  result.push({ time: data[period - 1].time, value: val })
  for (let i = period; i < data.length; i++) {
    val = data[i].close * k + val * (1 - k)
    result.push({ time: data[i].time, value: val })
  }
  return result
}

export function sma(data: OHLCV[], period: number): Point[] {
  const result: Point[] = []
  for (let i = period - 1; i < data.length; i++) {
    const avg = data.slice(i - period + 1, i + 1).reduce((s, d) => s + d.close, 0) / period
    result.push({ time: data[i].time, value: avg })
  }
  return result
}

export function bollingerBands(
  data: OHLCV[],
  period = 20,
  mult = 2
): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const upper: Point[] = []
  const middle: Point[] = []
  const lower: Point[] = []
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1).map(d => d.close)
    const avg = slice.reduce((s, v) => s + v, 0) / period
    const sd = Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / period)
    middle.push({ time: data[i].time, value: avg })
    upper.push({ time: data[i].time, value: avg + mult * sd })
    lower.push({ time: data[i].time, value: avg - mult * sd })
  }
  return { upper, middle, lower }
}

export function rsi(data: OHLCV[], period = 14): Point[] {
  if (data.length < period + 1) return []
  const result: Point[] = []
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = data[i].close - data[i - 1].close
    if (diff > 0) avgGain += diff
    else avgLoss += Math.abs(diff)
  }
  avgGain /= period
  avgLoss /= period
  for (let i = period + 1; i < data.length; i++) {
    const diff = data[i].close - data[i - 1].close
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
    result.push({ time: data[i].time, value: 100 - 100 / (1 + rs) })
  }
  return result
}

export function macd(
  data: OHLCV[],
  fast = 12,
  slow = 26,
  signal = 9
): { macdLine: Point[]; signalLine: Point[]; histogram: Point[] } {
  const fastEma = ema(data, fast)
  const slowEma = ema(data, slow)
  const slowMap = new Map(slowEma.map(p => [p.time, p.value]))
  const fastMap = new Map(fastEma.map(p => [p.time, p.value]))
  const macdLine: Point[] = []
  for (const [time, sv] of slowMap) {
    const fv = fastMap.get(time)
    if (fv !== undefined) macdLine.push({ time, value: fv - sv })
  }
  macdLine.sort((a, b) => a.time - b.time)
  if (macdLine.length < signal) return { macdLine, signalLine: [], histogram: [] }
  const k = 2 / (signal + 1)
  const signalLine: Point[] = []
  let sigVal = macdLine.slice(0, signal).reduce((s, p) => s + p.value, 0) / signal
  for (let i = signal - 1; i < macdLine.length; i++) {
    if (i > signal - 1) sigVal = macdLine[i].value * k + sigVal * (1 - k)
    signalLine.push({ time: macdLine[i].time, value: sigVal })
  }
  const sigMap = new Map(signalLine.map(p => [p.time, p.value]))
  const histogram = macdLine
    .filter(p => sigMap.has(p.time))
    .map(p => ({ time: p.time, value: p.value - sigMap.get(p.time)! }))
  return { macdLine, signalLine, histogram }
}
