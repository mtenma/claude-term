import * as path from 'node:path'
import type {AgentKind, UsageAmount, UsagePeriod, UsageProject, UsageReport} from '../shared/types'
import {LONG_CONTEXT_TOKENS, PRICING_CHECKED_AT, WEB_SEARCH_USD, ratesFor} from './usagePricing'
import type {UsageGroup, UsageStore} from './usageStore'

const BUCKET_MS = 15 * 60_000

const emptyAmount = (): UsageAmount => ({cost: 0, tokens: 0, cacheRead: 0, unknownTokens: 0})

function addAmount(target: UsageAmount, source: UsageAmount): void {
  target.cost += source.cost
  target.tokens += source.tokens
  target.cacheRead += source.cacheRead
  target.unknownTokens += source.unknownTokens
}

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days)
const pad = (n: number) => String(n).padStart(2, '0')
export const localDay = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

/** 期間の初日と最終日(どちらも現地日付で、今日を含む暦日) */
export function periodRange(period: UsagePeriod, now: Date): {first: Date; last: Date} {
  const today = startOfDay(now)
  switch (period) {
    case '7d':
      return {first: addDays(today, -6), last: today}
    case '30d':
      return {first: addDays(today, -29), last: today}
    case 'thisMonth':
      return {first: new Date(today.getFullYear(), today.getMonth(), 1), last: today}
    case 'lastMonth':
      return {
        first: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        last: new Date(today.getFullYear(), today.getMonth(), 0),
      }
  }
}

/** 1 グループ分の額とトークン。料金表にないモデルは額を付けず unknownTokens に入れる */
function amountOf(group: UsageGroup): UsageAmount {
  const tokens = group.input + group.cacheWrite5m + group.cacheWrite1h + group.output
  const rates = ratesFor(group.agent, group.model, group.speed, group.geo, group.longContext === 1)
  if (!rates) return {cost: 0, tokens, cacheRead: group.cacheRead, unknownTokens: tokens}
  const cost = (group.input * rates.input + group.cacheWrite5m * rates.cacheWrite5m +
    group.cacheWrite1h * rates.cacheWrite1h + group.cacheRead * rates.cacheRead + group.output * rates.output) / 1e6 +
    (group.agent === 'claude' ? group.webSearch * WEB_SEARCH_USD : 0)
  return {cost, tokens, cacheRead: group.cacheRead, unknownTokens: 0}
}

const tilde = (file: string, home: string) =>
  file === home ? '~' : file.startsWith(`${home}/`) ? `~${file.slice(home.length)}` : file

function projectIdentity(group: UsageGroup): {id: string; kind: UsageProject['kind']} {
  if (group.kind === 'temp') return {id: 'temp', kind: 'temp'}
  if (group.kind === 'unknown' || !group.root) return {id: 'unknown', kind: 'unknown'}
  return {id: group.root, kind: group.kind === 'git' ? 'git' : 'dir'}
}

/** フォルダ名が重なるプロジェクトには親フォルダ名を付けて区別する */
function nameProjects(projects: UsageProject[]): void {
  const counts = new Map<string, number>()
  for (const p of projects) {
    if (p.kind === 'temp' || p.kind === 'unknown') continue
    counts.set(path.basename(p.id), (counts.get(path.basename(p.id)) ?? 0) + 1)
  }
  for (const p of projects) {
    if (p.kind === 'temp') p.name = '一時フォルダ'
    else if (p.kind === 'unknown') p.name = '作業フォルダ不明'
    else {
      const base = path.basename(p.id) || p.id
      p.name = (counts.get(base) ?? 0) > 1 ? `${path.basename(path.dirname(p.id))}/${base}` : base
    }
  }
}

const totalCost = (p: UsageProject) => p.claude.cost + p.codex.cost
const totalTokens = (p: UsageProject) => p.claude.tokens + p.codex.tokens

export interface ReportOptions {
  store: UsageStore
  period: UsagePeriod
  now: number
  home: string
}

function periodDays(period: UsagePeriod, now: Date): {days: string[]; start: number; end: number} {
  const {first, last} = periodRange(period, now)
  const days: string[] = []
  for (let d = first; d <= last; d = addDays(d, 1)) days.push(localDay(d))
  return {days, start: first.getTime(), end: addDays(last, 1).getTime()}
}

/** 集計データがまだない(初回・削除の直後)ときの空の結果。DB は作らない */
export function emptyReport(period: UsagePeriod, now: number, file: string, home: string): UsageReport {
  const {days} = periodDays(period, new Date(now))
  return {
    period, days, projects: [], daily: days.map(() => []), today: emptyAmount(), unknownModels: [],
    earliest: {claude: null, codex: null}, lastScanAt: null, generatedAt: now,
    pricingCheckedAt: PRICING_CHECKED_AT, storagePath: tilde(file, home),
  }
}

export function buildReport({store, period, now, home}: ReportOptions): UsageReport {
  const storagePath = tilde(store.file, home)
  const nowDate = new Date(now)
  const {days, start, end} = periodDays(period, nowDate)
  const dayIndex = new Map(days.map((day, index) => [day, index]))

  const projects: UsageProject[] = []
  const projectIndex = new Map<string, number>()
  const cells = new Map<string, UsageAmount>()
  const unknown = new Map<string, {agent: AgentKind; model: string; tokens: number}>()

  for (const group of store.groups(start, end, LONG_CONTEXT_TOKENS)) {
    const day = dayIndex.get(localDay(new Date(group.bucket * BUCKET_MS)))
    if (day === undefined) continue
    const {id, kind} = projectIdentity(group)
    let index = projectIndex.get(id)
    if (index === undefined) {
      index = projects.length
      projectIndex.set(id, index)
      projects.push({
        id, name: '', path: kind === 'git' || kind === 'dir' ? tilde(id, home) : '', kind,
        claude: emptyAmount(), codex: emptyAmount(), lastUsedAt: 0,
      })
    }
    const project = projects[index]
    const amount = amountOf(group)
    addAmount(project[group.agent], amount)
    project.lastUsedAt = Math.max(project.lastUsedAt, group.last)
    const cellKey = `${day}:${index}`
    const cell = cells.get(cellKey) ?? emptyAmount()
    addAmount(cell, amount)
    cells.set(cellKey, cell)
    if (amount.unknownTokens > 0) {
      const key = `${group.agent}:${group.model}`
      const entry = unknown.get(key) ?? {agent: group.agent, model: group.model, tokens: 0}
      entry.tokens += amount.unknownTokens
      unknown.set(key, entry)
    }
  }

  nameProjects(projects)
  // 表とグラフの並びは額の多い順(同額ならトークンの多い順)。画面側で指標に合わせて並べ替える
  const order = projects.map((_, index) => index)
    .sort((a, b) => totalCost(projects[b]) - totalCost(projects[a]) || totalTokens(projects[b]) - totalTokens(projects[a]))
  const daily = days.map((_, day) => order.map((index) => cells.get(`${day}:${index}`) ?? emptyAmount()))

  // 「今日」は選んだ期間に関係なく出す(先月を見ているときも今日の分がわかるように)
  const today = emptyAmount()
  const todayStart = startOfDay(nowDate)
  for (const group of store.groups(todayStart.getTime(), addDays(todayStart, 1).getTime(), LONG_CONTEXT_TOKENS)) {
    addAmount(today, amountOf(group))
  }

  const lastScan = store.getMeta('lastScanAt')
  return {
    period,
    days,
    projects: order.map((index) => projects[index]),
    daily,
    today,
    unknownModels: [...unknown.values()].sort((a, b) => b.tokens - a.tokens),
    earliest: store.earliest(),
    lastScanAt: lastScan === null ? null : Number(lastScan),
    generatedAt: now,
    pricingCheckedAt: PRICING_CHECKED_AT,
    storagePath,
  }
}
