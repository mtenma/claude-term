import './cost.css'
import type {AgentKind, AppearanceSettings, UsageErrorCode, UsageEvent, UsagePeriod, UsageReport} from '../shared/types'
import {AGENT_LABELS} from '../shared/types'
import type {ClaudeTermUsageApi} from '../preload/usagePreload'
import {
  buildSeries, formatValue, isLightColor, labelDay, niceTicks, projectAmount, relativeTime, shortDay,
  stackDays, valueOf, weekday, type DayStack, type Metric, type Series, type ViewOptions,
} from './costModel'

declare global {
  interface Window {
    claudeTermUsage: ClaudeTermUsageApi
  }
}

const api = window.claudeTermUsage
const SVG = 'http://www.w3.org/2000/svg'
const NOTICE_KEY = 'claude-term.usage.noticeSeen'
const CHART_MARGIN = {top: 12, right: 8, bottom: 28, left: 56}

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) => {
  const node = document.createElementNS(SVG, tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

let report: UsageReport | null = null
let period: UsagePeriod = '7d'
let view: ViewOptions = {metric: 'cost', withCacheRead: false}
let filter: number | null = null
let showTable = false
let focusedDay: number | null = null
let statusMessage = ''
let loadingReport = false
let reloadQueued = false

// ---- 外観 ----

function applyAppearance(a: AppearanceSettings): void {
  const root = document.documentElement
  root.style.setProperty('--bg', a.background)
  root.style.setProperty('--text', a.foreground)
  root.style.setProperty('--accent', a.accent)
  // 透過は使わない(グラフが壁紙に透けて読みにくくなるため)
  root.dataset.theme = isLightColor(a.background) ? 'light' : 'dark'
  render()
}

// ---- 取得 ----

async function loadReport(): Promise<void> {
  if (loadingReport) {
    reloadQueued = true
    return
  }
  loadingReport = true
  try {
    report = await api.getReport(period)
    if (filter !== null && filter >= report.projects.length) filter = null
    document.body.dataset.state = 'ready'
  } catch {
    showError('internal')
  } finally {
    loadingReport = false
  }
  render()
  if (reloadQueued) {
    reloadQueued = false
    void loadReport()
  }
}

const ERROR_TEXT: Record<UsageErrorCode, string> = {
  db_newer: '新しい版の Claude Term で作られた集計データのため開けません。',
  db_failed: '集計データを開けませんでした。',
  service_exited: '集計処理が停止しました。',
  timeout: '集計に時間がかかっています。',
  internal: '集計中にエラーが発生しました。',
}

function showError(code: UsageErrorCode): void {
  statusMessage = `${ERROR_TEXT[code]}「更新」で再試行できます。`
  el('progress').textContent = ''
  renderStatus()
}

function onEvent(event: UsageEvent): void {
  const progress = el('progress')
  if (event.kind === 'progress') {
    const gb = (bytes: number) => (bytes / 1e9).toFixed(bytes >= 1e9 ? 1 : 2)
    if (event.totalBytes > 0) {
      progress.textContent = event.firstImport
        ? `初回の取り込み中 ${gb(event.doneBytes)} / ${gb(event.totalBytes)} GB(会話本文は保存しません)`
        : `取り込み中 ${gb(event.doneBytes)} / ${gb(event.totalBytes)} GB`
    }
  } else if (event.kind === 'scanned') {
    progress.textContent = ''
    const skipped = event.unreadable + event.parseErrors
    statusMessage = skipped > 0 ? `読めなかったファイル・行 ${skipped} 件` : ''
    void loadReport()
  } else if (event.kind === 'error') {
    showError(event.code)
  } else if (event.kind === 'deleted') {
    progress.textContent = ''
    statusMessage = '集計データを削除しました。「更新」で残っている記録から作り直します。'
    void loadReport()
  }
}

// ---- 描画 ----

const metricLabel = () => view.metric === 'cost' ? 'API換算額' : 'トークン'
const fmt = (value: number, short = false) => formatValue(value, view.metric, short)

function render(): void {
  renderToolbar()
  if (!report) return
  const series = buildSeries(report, view)
  const days = stackDays(report, series, view, filter)
  renderSummary(days)
  renderLegend(series)
  renderChart(series, days)
  renderDailyTable(series, days)
  renderProjects(series)
  renderStatus()
  renderHelp()
}

function renderToolbar(): void {
  el('cache-read-option').hidden = view.metric !== 'tokens'
  if (!report) return
  const first = report.days[0]
  const last = report.days.at(-1)!
  el('range').textContent = `${shortDay(first)}〜${shortDay(last)}`
  for (const node of document.querySelectorAll('.storage-path')) node.textContent = report.storagePath
}

function renderSummary(days: DayStack[]): void {
  const r = report!
  const projects = filter === null ? r.projects : [r.projects[filter]]
  const total = days.reduce((sum, d) => sum + d.total, 0)
  el('total-label').textContent = filter === null ? '期間合計' : '期間合計(絞り込み中)'
  el('total-value').textContent = fmt(total, true)
  el('total-value').title = fmt(total)
  const byAgent = (agent: AgentKind) => projects.reduce((sum, p) => sum + valueOf(p[agent], view), 0)
  const unknown = projects.reduce((sum, p) => sum + projectAmount(p).unknownTokens, 0)
  const sub = el('total-sub')
  sub.replaceChildren(make('span', '', `Claude ${fmt(byAgent('claude'), true)} · Codex ${fmt(byAgent('codex'), true)}`))
  if (unknown > 0 && view.metric === 'cost') sub.append(make('span', 'tag', '+料金不明'))

  // 今日: 絞り込み中は日別の値から、期間外なら出さない
  const todayIndex = r.days.length - 1
  const isTodayInPeriod = r.days[todayIndex] === localToday()
  let today: string
  if (filter === null) today = fmt(valueOf(r.today, view), true)
  else today = isTodayInPeriod ? fmt(days[todayIndex].total, true) : '—'
  el('today-value').textContent = today
  el('today-sub').textContent = filter === null && r.today.unknownTokens > 0 && view.metric === 'cost'
    ? `+料金不明 ${formatValue(r.today.unknownTokens, 'tokens', true)} トークン` : ''

  const models = filter === null ? r.unknownModels : []
  el('unknown-value').textContent = unknown > 0 ? `${formatValue(unknown, 'tokens', true)} トークン` : 'なし'
  const unknownSub = el('unknown-sub')
  if (unknown > 0) {
    const names = models.map((m) => m.model || 'モデル不明')
    const head = names.length ? `${names[0]}${names.length > 1 ? ` ほか ${names.length - 1} モデル` : ''}。` : ''
    unknownSub.textContent = `${head}料金表にないため金額の合計に含めていません`
    unknownSub.title = models.map((m) => `${AGENT_LABELS[m.agent]} ${m.model || 'モデル不明'}: ${formatValue(m.tokens, 'tokens')}`).join('\n')
  } else {
    unknownSub.textContent = ''
    unknownSub.title = ''
  }

  el('caveat').textContent = view.metric === 'cost'
    ? `※ 現在の API 単価(料金表 ${r.pricingCheckedAt} 確認)で換算した目安です。定額プランの請求額ではありません。`
    : `※ トークンは入力・キャッシュ書込・出力の合計です${view.withCacheRead ? '(キャッシュ読込を含む)' : '。キャッシュ読込は含めません'}。`

  el('filter').hidden = filter === null
  if (filter !== null) el('filter-name').textContent = r.projects[filter].name
}

function localToday(): string {
  const d = new Date(report?.generatedAt ?? Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const seriesClass = (s: Series) => s.slot === null ? 's-others' : `s-${s.slot + 1}`

function swatch(s: Series): HTMLElement {
  const node = make('span', `swatch ${seriesClass(s)}`)
  node.setAttribute('aria-hidden', 'true')
  return node
}

function renderLegend(series: Series[]): void {
  const legend = el('legend')
  legend.replaceChildren(...series.map((s) => {
    const item = make('li')
    item.append(swatch(s), make('span', '', s.name))
    return item
  }))
}

function renderChart(series: Series[], days: DayStack[]): void {
  const chart = el('chart')
  const empty = el('empty')
  const total = days.reduce((sum, d) => sum + d.total, 0)
  const r = report!
  const hasAny = r.earliest.claude !== null || r.earliest.codex !== null
  empty.hidden = total > 0
  if (total === 0) {
    empty.textContent = !hasAny
      ? (r.lastScanAt === null ? '記録を取り込んでいます…' : 'Claude Code と Codex の記録が見つかりませんでした。')
      : 'この期間の利用はありません。'
  }
  chart.hidden = showTable || total === 0
  // 期間や指標が変わったら前の内訳を残さない(キーボードで選んだ日は下で出し直す)
  if (focusedDay === null || chart.hidden) el('tooltip').hidden = true
  if (chart.hidden) {
    chart.replaceChildren()
    return
  }

  const width = Math.max(320, chart.clientWidth)
  const height = 240
  const margin = CHART_MARGIN
  const plotW = width - margin.left - margin.right
  const plotH = height - margin.top - margin.bottom
  const max = Math.max(...days.map((d) => d.total))
  const ticks = niceTicks(max)
  const top = ticks.at(-1) || 1
  const y = (value: number) => margin.top + plotH - (value / top) * plotH
  const band = plotW / days.length
  const barW = Math.min(24, Math.max(4, band * 0.62))

  const root = svg('svg', {width, height, viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true'})
  for (const tick of ticks) {
    root.append(svg('line', {x1: margin.left, x2: width - margin.right, y1: y(tick), y2: y(tick), class: 'grid'}))
    const label = svg('text', {x: margin.left - 8, y: y(tick) + 4, class: 'axis', 'text-anchor': 'end'})
    label.textContent = fmt(tick, true)
    root.append(label)
  }
  const earliestDay = earliestRecordDay()
  days.forEach((day, i) => {
    const cx = margin.left + band * (i + 0.5)
    const x = cx - barW / 2
    if (labelDay(day.day, days.length)) {
      const label = svg('text', {x: cx, y: height - 8, class: 'axis', 'text-anchor': 'middle'})
      label.textContent = days.length <= 7 ? `${shortDay(day.day)}(${weekday(day.day)})` : shortDay(day.day)
      root.append(label)
    }
    if (day.total === 0) {
      // 記録がある日の 0 は基準線に小さな印を付け、記録が始まる前の日と区別する
      if (earliestDay !== null && day.day >= earliestDay) {
        root.append(svg('rect', {x, y: y(0) - 2, width: barW, height: 2, class: 'zero'}))
      }
    } else {
      let base = 0
      const visible = day.values.map((value, index) => ({value, index})).filter((v) => v.value > 0)
      visible.forEach(({value, index}, n) => {
        const y0 = y(base)
        const y1 = y(base + value)
        base += value
        // 積み上げの区切りは背景色の 2px の隙間で表す。一番上だけ角を丸める
        const gap = n > 0 && y0 - y1 > 3 ? 2 : 0
        const h = Math.max(0.5, y0 - y1 - gap)
        const cls = `bar ${seriesClass(series[index])}`
        if (n === visible.length - 1) {
          const radius = Math.min(4, h, barW / 2)
          root.append(svg('path', {
            class: cls,
            d: `M${x},${y1 + h} V${y1 + radius} Q${x},${y1} ${x + radius},${y1} H${x + barW - radius} ` +
              `Q${x + barW},${y1} ${x + barW},${y1 + radius} V${y1 + h} Z`,
          }))
        } else {
          root.append(svg('rect', {class: cls, x, y: y1, width: barW, height: h}))
        }
      })
    }
    const hit = svg('rect', {x: margin.left + band * i, y: margin.top, width: band, height: plotH, class: 'hit'})
    hit.addEventListener('mouseenter', () => showTooltip(i, series, days))
    hit.addEventListener('mouseleave', hideTooltip)
    root.append(hit)
  })
  root.append(svg('line', {x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), class: 'baseline'}))
  chart.replaceChildren(root)

  const peak = days.reduce((best, d) => d.total > best.total ? d : best, days[0])
  chart.setAttribute('aria-label', `日別の積み上げ棒グラフ。${shortDay(days[0].day)}〜${shortDay(days.at(-1)!.day)}、` +
    `${metricLabel()}の合計 ${fmt(total)}。最も多いのは ${shortDay(peak.day)} の ${fmt(peak.total)}。` +
    '左右の矢印キーで日ごとの内訳を表示します。')
  if (focusedDay !== null && focusedDay < days.length) showTooltip(focusedDay, series, days)
}

function earliestRecordDay(): string | null {
  const values = [report!.earliest.claude, report!.earliest.codex].filter((v): v is number => v !== null)
  if (!values.length) return null
  const d = new Date(Math.min(...values))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function showTooltip(index: number, series: Series[], days: DayStack[]): void {
  const day = days[index]
  const tip = el('tooltip')
  const head = make('div', 'tip-head', `${shortDay(day.day)}(${weekday(day.day)}) ${fmt(day.total)}`)
  const rows = series.map((s, i) => ({s, value: day.values[i]})).filter((row) => row.value > 0).reverse()
  const list = make('ul')
  for (const {s, value} of rows) {
    const item = make('li')
    item.append(swatch(s), make('span', 'tip-name', s.name), make('span', 'tip-value', fmt(value)))
    list.append(item)
  }
  tip.replaceChildren(head, list)
  if (day.unknownTokens > 0 && view.metric === 'cost') {
    tip.append(make('div', 'tip-note', `料金不明 ${formatValue(day.unknownTokens, 'tokens')} トークン(合計に含めず)`))
  }
  if (view.metric === 'tokens' && !view.withCacheRead && day.cacheRead > 0) {
    tip.append(make('div', 'tip-note', `キャッシュ読込 ${formatValue(day.cacheRead, 'tokens')}(含めず)`))
  }
  if (day.total === 0) tip.append(make('div', 'tip-note', '利用なし'))
  tip.hidden = false
  // 指している棒を隠さないよう、棒の右(はみ出すなら左)に出す
  const chart = el('chart')
  const band = (Math.max(320, chart.clientWidth) - CHART_MARGIN.left - CHART_MARGIN.right) / days.length
  const center = chart.offsetLeft + CHART_MARGIN.left + band * (index + 0.5)
  const right = center + band / 2 + 8
  const fits = right + tip.offsetWidth <= chart.offsetLeft + chart.clientWidth
  tip.style.left = `${Math.max(chart.offsetLeft, fits ? right : center - band / 2 - 8 - tip.offsetWidth)}px`
  tip.style.top = `${chart.offsetTop + CHART_MARGIN.top}px`
}

function hideTooltip(): void {
  if (focusedDay === null) el('tooltip').hidden = true
}

function renderDailyTable(series: Series[], days: DayStack[]): void {
  const host = el('daily-table')
  const total = days.reduce((sum, d) => sum + d.total, 0)
  host.hidden = !showTable || total === 0
  el('table-toggle').textContent = showTable ? 'グラフで見る' : '日別の表で見る'
  el('table-toggle').setAttribute('aria-pressed', String(showTable))
  if (host.hidden) {
    host.replaceChildren()
    return
  }
  const table = make('table', 'daily')
  table.append(make('caption', 'sr-only', `日別の${metricLabel()}`))
  const head = make('tr')
  head.append(make('th', '', '日付'))
  for (const s of series) {
    const th = make('th', 'num')
    th.append(swatch(s), make('span', '', s.name))
    head.append(th)
  }
  head.append(make('th', 'num', '合計'))
  for (const th of head.children) th.setAttribute('scope', 'col')
  const thead = make('thead')
  thead.append(head)
  const body = make('tbody')
  for (const day of days) {
    const row = make('tr')
    const th = make('th', '', `${shortDay(day.day)}(${weekday(day.day)})`)
    th.setAttribute('scope', 'row')
    row.append(th, ...day.values.map((v) => make('td', 'num', fmt(v))), make('td', 'num', fmt(day.total)))
    body.append(row)
  }
  table.append(thead, body)
  host.replaceChildren(table)
}

function renderProjects(series: Series[]): void {
  const r = report!
  const other: Metric = view.metric === 'cost' ? 'tokens' : 'cost'
  const otherView: ViewOptions = {metric: other, withCacheRead: false}
  const unit = view.metric === 'cost' ? '額' : 'トークン'
  el('col-main').textContent = metricLabel()
  el('col-claude').textContent = `Claude(${unit})`
  el('col-codex').textContent = `Codex(${unit})`
  el('col-other').textContent = other === 'cost' ? 'API換算額' : 'トークン'
  const slotOf = new Map<number, Series>()
  for (const s of series) if (s.slot !== null) slotOf.set(s.projects[0], s)
  const order = r.projects.map((_, i) => i)
    .sort((a, b) => valueOf(projectAmount(r.projects[b]), view) - valueOf(projectAmount(r.projects[a]), view))
  const body = document.querySelector('#projects tbody')!
  body.replaceChildren(...order.map((index) => {
    const p = r.projects[index]
    const amount = projectAmount(p)
    const row = make('tr')
    if (filter !== null && filter !== index) row.classList.add('dimmed')
    const nameCell = make('th')
    nameCell.setAttribute('scope', 'row')
    const s = slotOf.get(index)
    const button = make('button', 'project-button')
    button.type = 'button'
    button.setAttribute('aria-pressed', String(filter === index))
    if (s) button.append(swatch(s))
    else button.append(make('span', 'swatch empty-swatch'))
    button.append(make('span', 'project-name', p.name))
    button.addEventListener('click', () => {
      filter = filter === index ? null : index
      render()
    })
    nameCell.append(button)
    if (p.path) nameCell.append(make('div', 'project-path', p.path))
    const money = (value: number, unknownTokens: number) => {
      const cell = make('td', 'num', view.metric === 'cost' ? fmt(value) : formatValue(value, 'tokens'))
      if (view.metric === 'cost' && unknownTokens > 0) cell.append(make('span', 'tag', '+料金不明'))
      return cell
    }
    row.append(
      nameCell,
      money(valueOf(amount, view), amount.unknownTokens),
      money(valueOf(p.claude, view), p.claude.unknownTokens),
      money(valueOf(p.codex, view), p.codex.unknownTokens),
      make('td', 'num', formatValue(valueOf(amount, otherView), other)),
      make('td', 'num', lastUsed(p.lastUsedAt)),
    )
    return row
  }))
  if (!order.length) {
    const row = make('tr')
    const cell = make('td', 'empty-row', 'この期間の利用はありません。')
    cell.colSpan = 6
    row.append(cell)
    body.replaceChildren(row)
  }
}

function lastUsed(at: number): string {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function renderStatus(): void {
  const status = el('status')
  const r = report
  const parts: string[] = []
  if (r?.lastScanAt) {
    const at = new Date(r.lastScanAt)
    parts.push(`最終更新 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` +
      `(${relativeTime(r.lastScanAt, Date.now())})`)
  }
  if (statusMessage) parts.push(statusMessage)
  status.textContent = parts.join(' · ')

  const notes: string[] = []
  if (r) {
    for (const agent of ['claude', 'codex'] as const) {
      const at = r.earliest[agent]
      if (at === null) continue
      const d = new Date(at)
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      if (r.days[0] < day) notes.push(`${AGENT_LABELS[agent]} の記録は ${shortDay(day)} 以降のみ`)
    }
  }
  el('earliest').textContent = notes.join(' · ')
}

function renderHelp(): void {
  const r = report!
  const items = [
    `金額は、記録のトークン数に現在の API 単価(料金表 ${r.pricingCheckedAt} 確認)を掛けた目安です。定額プランの請求額ではありません。過去の分も現在の単価で計算します。`,
    '料金表にないモデルは「料金不明」として、トークンだけ数え、金額の合計には含めません。',
    'トークンは入力・キャッシュ書込・出力の合計です。キャッシュ読込は量が多いため既定では含めません。',
    'プロジェクトは、セッションを始めたフォルダの git リポジトリでまとめます。途中で別のフォルダへ移った分も、始めたプロジェクトに数えます。',
    'Codex の 1 回の入力が 272K トークンを超えた呼出しは、長文脈の単価で計算します。古い Codex の記録には文脈圧縮の呼出しが残っていないため、その分は含まれません。',
    'ターミナルのカードに出る $ は Claude Code 自身の見積もりで、計算元が違うため一致しないことがあります。',
    `集計データは ${r.storagePath} に保存し、外部には送りません。Claude Code と Codex の元の記録が消えても集計は残ります。`,
  ]
  el('help-list').replaceChildren(...items.map((text) => make('li', '', text)))
}

// ---- 操作 ----

for (const input of document.querySelectorAll<HTMLInputElement>('input[name="period"]')) {
  input.addEventListener('change', () => {
    period = input.value as UsagePeriod
    filter = null
    focusedDay = null
    void loadReport()
  })
}
for (const input of document.querySelectorAll<HTMLInputElement>('input[name="metric"]')) {
  input.addEventListener('change', () => {
    view = {...view, metric: input.value as Metric}
    render()
  })
}
el<HTMLInputElement>('with-cache-read').addEventListener('change', (e) => {
  view = {...view, withCacheRead: (e.target as HTMLInputElement).checked}
  render()
})
el('filter-clear').addEventListener('click', () => {
  filter = null
  render()
})
el('table-toggle').addEventListener('click', () => {
  showTable = !showTable
  focusedDay = null
  render()
})
el('refresh').addEventListener('click', () => {
  statusMessage = ''
  api.refresh()
})
el('delete-data').addEventListener('click', () => void api.deleteData())

const chartEl = el('chart')
chartEl.addEventListener('keydown', (e) => {
  if (!report) return
  const count = report.days.length
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    const step = e.key === 'ArrowRight' ? 1 : -1
    focusedDay = focusedDay === null ? (step > 0 ? 0 : count - 1) : Math.max(0, Math.min(count - 1, focusedDay + step))
    render()
  } else if (e.key === 'Escape') {
    focusedDay = null
    el('tooltip').hidden = true
  }
})
chartEl.addEventListener('blur', () => {
  focusedDay = null
  el('tooltip').hidden = true
})

const notice = el('notice')
try {
  notice.hidden = localStorage.getItem(NOTICE_KEY) === '1'
} catch {
  notice.hidden = false
}
el('notice-close').addEventListener('click', () => {
  notice.hidden = true
  try {
    localStorage.setItem(NOTICE_KEY, '1')
  } catch {
    // 保存できなくても、この表示中は閉じたままにする
  }
})

// 幅が変わったときだけ描き直す(描画で高さが変わっても再描画しない)
let chartWidth = 0
new ResizeObserver(() => {
  if (chartEl.clientWidth === chartWidth) return
  chartWidth = chartEl.clientWidth
  if (report) render()
}).observe(chartEl)
// 「n 分前」の表示を進める
setInterval(renderStatus, 30_000)

api.onEvent(onEvent)
api.onSettingsUpdate(applyAppearance)
void api.getSettings().then(applyAppearance)
void loadReport()
