import type {UsageAmount, UsageProject, UsageReport} from '../shared/types'

// コスト画面の表示用の計算。DOM に依存しないので smoke テストから直接検証する

export type Metric = 'cost' | 'tokens'

export interface ViewOptions {
  metric: Metric
  withCacheRead: boolean
}

export const SERIES_LIMIT = 5

export const valueOf = (amount: UsageAmount, view: ViewOptions): number =>
  view.metric === 'cost' ? amount.cost : amount.tokens + (view.withCacheRead ? amount.cacheRead : 0)

export const projectAmount = (p: UsageProject): UsageAmount => ({
  cost: p.claude.cost + p.codex.cost,
  tokens: p.claude.tokens + p.codex.tokens,
  cacheRead: p.claude.cacheRead + p.codex.cacheRead,
  unknownTokens: p.claude.unknownTokens + p.codex.unknownTokens,
})

export interface Series {
  /** 色の枠(0 始まり)。「ほか」は null */
  slot: number | null
  name: string
  /** report.projects の添字 */
  projects: number[]
}

/** 期間の合計で上位 5 件を系列にし、残りを「ほか n 件」にまとめる(値が 0 のプロジェクトは描かない) */
export function buildSeries(report: UsageReport, view: ViewOptions): Series[] {
  const order = report.projects.map((_, index) => index)
    .filter((index) => valueOf(projectAmount(report.projects[index]), view) > 0)
    .sort((a, b) => valueOf(projectAmount(report.projects[b]), view) - valueOf(projectAmount(report.projects[a]), view))
  const series: Series[] = order.slice(0, SERIES_LIMIT)
    .map((index, slot) => ({slot, name: report.projects[index].name, projects: [index]}))
  const rest = order.slice(SERIES_LIMIT)
  if (rest.length) series.push({slot: null, name: `ほか ${rest.length} 件`, projects: rest})
  return series
}

export interface DayStack {
  day: string
  /** series と同じ並び。絞り込み中は対象以外を 0 にする */
  values: number[]
  total: number
  unknownTokens: number
  cacheRead: number
}

export function stackDays(report: UsageReport, series: Series[], view: ViewOptions, filter: number | null): DayStack[] {
  return report.days.map((day, d) => {
    const row = report.daily[d] ?? []
    const include = (index: number) => filter === null || filter === index
    const values = series.map((s) => s.projects.filter(include).reduce((sum, i) => sum + valueOf(row[i], view), 0))
    let unknownTokens = 0
    let cacheRead = 0
    row.forEach((amount, index) => {
      if (!include(index)) return
      unknownTokens += amount.unknownTokens
      cacheRead += amount.cacheRead
    })
    return {day, values, total: values.reduce((a, b) => a + b, 0), unknownTokens, cacheRead}
  })
}

/** 0 から始まる切りのよい目盛り(4〜6 本) */
export function niceTicks(max: number): number[] {
  if (!(max > 0)) return [0]
  const rough = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? 10 * magnitude
  const ticks: number[] = []
  for (let v = 0; v < max + step * 0.999; v += step) ticks.push(Number(v.toPrecision(12)))
  return ticks
}

const compact = (value: number): string => {
  const units: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
  for (const [size, unit] of units) {
    if (value >= size) {
      const scaled = value / size
      return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit}`
    }
  }
  return String(Math.round(value))
}

/** 表・ツールチップは全桁、軸と合計欄は略記 */
export function formatValue(value: number, metric: Metric, short = false): string {
  if (metric === 'tokens') return short ? compact(value) : Math.round(value).toLocaleString('en-US')
  if (short && value >= 1000) return `$${compact(value)}`
  if (value === 0) return '$0'
  if (value < 0.01) return '<$0.01'
  return `$${value.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
}

/** 取り込み量の表示。1GB 未満は MB で出す(小さい差分が 0.00 GB と出ないように) */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes > 0 && bytes < 1e6) return '1 MB 未満'
  return `${Math.round(bytes / 1e6)} MB`
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const parseDay = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}
export const shortDay = (day: string): string => {
  const date = parseDay(day)
  return `${date.getMonth() + 1}/${date.getDate()}`
}
export const weekday = (day: string): string => WEEKDAYS[parseDay(day).getDay()]

/** 横軸の日付ラベル: 7 日以下は毎日、それより長い期間は 1 日と月曜だけ */
export const labelDay = (day: string, count: number): boolean =>
  count <= 7 || parseDay(day).getDate() === 1 || parseDay(day).getDay() === 1

export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes} 分前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} 時間前` : `${Math.floor(hours / 24)} 日前`
}

export {isLightColor} from './color'
