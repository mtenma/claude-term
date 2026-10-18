import './cost.css'
import type {AgentKind, AppearanceSettings, UsageErrorCode, UsageEvent, UsagePeriod, UsageReport} from '../shared/types'
import {AGENT_LABELS} from '../shared/types'
import type {ClaudeTermUsageApi} from '../preload/usagePreload'
import {
  buildSeries, formatBytes, formatValue, isLightColor, labelDay, niceTicks, projectAmount, relativeTime, shortDay,
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
const dayKey = (at: number) => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let report: UsageReport | null = null
let period: UsagePeriod = '7d'
let view: ViewOptions = {metric: 'cost', withCacheRead: false}
/** 絞り込み中のプロジェクトの id。並び順は再集計で入れ替わるため添字では持たない */
let filter: string | null = null
let showTable = false
let focusedDay: number | null = null
let statusMessage = ''
let importing = false
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

const ERROR_TEXT: Record<UsageErrorCode, string> = {
  db_newer: '新しい版の Claude Term で作られた集計データのため開けません。',
  db_failed: '集計データを開けませんでした。',
  service_exited: '集計処理が停止しました。',
  timeout: '集計に時間がかかっています。',
  internal: '集計中にエラーが発生しました。',
}

function selectPeriodRadio(value: UsagePeriod): void {
  const radio = document.querySelector<HTMLInputElement>(`input[name="period"][value="${value}"]`)
  if (radio) radio.checked = true
}

async function loadReport(): Promise<void> {
  if (loadingReport) {
    reloadQueued = true
    return
  }
  loadingReport = true
  const requested = period
  try {
    const result = await api.getReport(requested)
    // 取得中に期間が変わった・次の取得が控えている場合は、古い結果を描かない
    if (!reloadQueued && requested === period) {
      if ('error' in result) {
        showError(result.error)
        // 画面の期間を、表示している集計の期間に戻す
        if (report) {
          period = report.period
          selectPeriodRadio(period)
        }
      } else {
        report = result.report
        document.body.dataset.state = 'ready'
        showNoticeOnce()
      }
    }
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

function showError(code: UsageErrorCode): void {
  importing = false
  statusMessage = `${ERROR_TEXT[code]}「更新」で再試行できます。`
  el('progress').textContent = ''
  renderStatus()
}

function onEvent(event: UsageEvent): void {
  const progress = el('progress')
  if (event.kind === 'progress') {
    importing = true
    if (event.totalBytes > 0) {
      const amount = `${formatBytes(event.doneBytes)} / ${formatBytes(event.totalBytes)}`
      progress.textContent = event.firstImport ? `初回の取り込み中 ${amount}(会話本文は保存しません)` : `取り込み中 ${amount}`
    }
    if (report === null || report.lastScanAt === null) render()
  } else if (event.kind === 'scanned') {
    importing = false
    progress.textContent = ''
    const skipped = event.unreadable + event.parseErrors
    statusMessage = skipped > 0 ? `読めなかったファイル・行 ${skipped} 件` : ''
    void loadReport()
  } else if (event.kind === 'error') {
    showError(event.code)
    render()
  } else if (event.kind === 'deleted') {
    importing = false
    progress.textContent = ''
    filter = null
    statusMessage = '集計データを削除しました。「更新」で残っている記録から作り直します。'
    void loadReport()
  }
}

// ---- 描画 ----

const metricLabel = () => view.metric === 'cost' ? 'API換算額' : 'トークン'
const fmt = (value: number, short = false) => formatValue(value, view.metric, short)

/** 絞り込み中のプロジェクトの添字。再集計でなくなっていたら解除する */
function filterIndex(): number | null {
  if (filter === null || !report) return null
  const index = report.projects.findIndex((p) => p.id === filter)
  if (index === -1) {
    filter = null
    statusMessage = '絞り込んでいたプロジェクトがこの期間にないため、解除しました。'
    return null
  }
  return index
}

/** 絞り込み中は、そのプロジェクトだけを系列にする(色は絞り込む前の割り当てを引き継ぐ) */
function seriesFor(index: number | null): Series[] {
  const all = buildSeries(report!, view)
  if (index === null) return all
  const own = all.find((s) => s.slot !== null && s.projects[0] === index)
  return [{slot: own?.slot ?? null, name: report!.projects[index].name, projects: [index]}]
}

function render(): void {
  renderToolbar()
  if (!report) {
    renderEmpty(0, 0)
    renderStatus()
    return
  }
  const index = filterIndex()
  const series = seriesFor(index)
  const days = stackDays(report, series, view, index)
  renderSummary(days, index)
  renderLegend(series)
  renderChart(series, days)
  renderDailyTable(series, days)
  renderProjects(index)
  renderStatus()
  renderHelp()
}

function renderToolbar(): void {
  el('cache-read-option').hidden = view.metric !== 'tokens'
  if (!report) return
  el('range').textContent = `${shortDay(report.days[0])}〜${shortDay(report.days.at(-1)!)}`
  for (const node of document.querySelectorAll('.storage-path')) node.textContent = report.storagePath
}

function showNoticeOnce(): void {
  try {
    el('notice').hidden = localStorage.getItem(NOTICE_KEY) === '1'
  } catch {
    el('notice').hidden = false
  }
}

function renderSummary(days: DayStack[], index: number | null): void {
  const r = report!
  const filtered = index !== null
  const projects = filtered ? [r.projects[index]] : r.projects
  const suffix = filtered ? '(絞り込み中)' : ''
  const total = days.reduce((sum, d) => sum + d.total, 0)
  el('total-label').textContent = `期間合計${suffix}`
  el('total-value').textContent = fmt(total, true)
  el('total-value').title = fmt(total)
  const byAgent = (agent: AgentKind) => projects.reduce((sum, p) => sum + valueOf(p[agent], view), 0)
  const unknown = projects.reduce((sum, p) => sum + projectAmount(p).unknownTokens, 0)
  const sub = el('total-sub')
  sub.replaceChildren(make('span', '', `Claude ${fmt(byAgent('claude'), true)} · Codex ${fmt(byAgent('codex'), true)}`))
  if (unknown > 0 && view.metric === 'cost') sub.append(make('span', 'tag', '+料金不明'))

  // 今日: 絞り込み中は日別の値から求め、期間に今日が含まれなければ出さない
  el('today-label').textContent = `今日${suffix}`
  const last = days.at(-1)
  const todayInPeriod = last?.day === dayKey(r.generatedAt)
  let todayValue = '—'
  let todayUnknown = 0
  if (!filtered) {
    todayValue = fmt(valueOf(r.today, view), true)
    todayUnknown = r.today.unknownTokens
  } else if (todayInPeriod && last) {
    todayValue = fmt(last.total, true)
    todayUnknown = last.unknownTokens
  }
  el('today-value').textContent = todayValue
  el('today-sub').textContent = todayUnknown > 0 && view.metric === 'cost'
    ? `+料金不明 ${formatValue(todayUnknown, 'tokens', true)} トークン` : ''

  el('unknown-label').textContent = `料金不明${suffix}`
  el('unknown-value').textContent = unknown > 0 ? `${formatValue(unknown, 'tokens', true)} トークン` : 'なし'
  const unknownSub = el('unknown-sub')
  unknownSub.title = ''
  if (unknown === 0) {
    unknownSub.textContent = ''
  } else if (filtered) {
    unknownSub.textContent = '料金表にないモデルの分。金額の合計に含めていません'
  } else {
    const names = r.unknownModels.map((m) => m.model || 'モデル不明')
    const head = names.length ? `${names[0]}${names.length > 1 ? ` ほか ${names.length - 1} モデル` : ''}。` : ''
    unknownSub.textContent = `${head}料金表にないため金額の合計に含めていません`
    unknownSub.title = r.unknownModels
      .map((m) => `${AGENT_LABELS[m.agent]} ${m.model || 'モデル不明'}: ${formatValue(m.tokens, 'tokens')}`).join('\n')
  }

  el('caveat').textContent = view.metric === 'cost'
    ? `※ 現在の API 単価(料金表 ${r.pricingCheckedAt} 確認)で換算した目安です。定額プランの請求額ではありません。`
    : `※ トークンは入力・キャッシュ書込・出力の合計です${view.withCacheRead ? '(キャッシュ読込を含む)' : '。キャッシュ読込は含めません'}。`

  el('filter').hidden = !filtered
  if (filtered) el('filter-name').textContent = r.projects[index].name
}

const seriesClass = (s: Series) => s.slot === null ? 's-others' : `s-${s.slot + 1}`

function swatch(s: Series): HTMLElement {
  const node = make('span', `swatch ${seriesClass(s)}`)
  node.setAttribute('aria-hidden', 'true')
  return node
}

function renderLegend(series: Series[]): void {
  el('legend').replaceChildren(...series.map((s) => {
    const item = make('li')
    item.append(swatch(s), make('span', '', s.name))
    return item
  }))
}

/** グラフの代わりに出す案内。取り込み中・集計データなし・記録なし・利用なしを分ける */
function renderEmpty(total: number, unknownTokens: number): boolean {
  const empty = el('empty')
  const r = report
  let message = ''
  if (!r) message = importing ? '記録を取り込んでいます…' : statusMessage ? '集計を読み込めませんでした。' : '読み込み中…'
  else if (total === 0) {
    const hasAny = r.earliest.claude !== null || r.earliest.codex !== null
    if (importing && (r.lastScanAt === null || !hasAny)) message = '記録を取り込んでいます…'
    else if (r.lastScanAt === null) message = '集計データはありません。「更新」で Claude Code と Codex の記録から取り込みます。'
    else if (!hasAny) message = 'Claude Code と Codex の記録が見つかりませんでした。'
    else if (unknownTokens > 0 && view.metric === 'cost') {
      message = 'この期間は料金表にないモデルだけが使われています。「トークン」に切り替えると量を確認できます。'
    } else message = 'この期間の利用はありません。'
  }
  empty.textContent = message
  empty.hidden = message === ''
  return message !== ''
}

function renderChart(series: Series[], days: DayStack[]): void {
  const chart = el('chart')
  const total = days.reduce((sum, d) => sum + d.total, 0)
  const unknownTokens = days.reduce((sum, d) => sum + d.unknownTokens, 0)
  const isEmpty = renderEmpty(total, unknownTokens)
  chart.hidden = showTable || isEmpty
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
  const ticks = niceTicks(Math.max(...days.map((d) => d.total)))
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
    // キーボードで選んだ日があれば、マウスが離れたらその日の内訳に戻す
    hit.addEventListener('mouseleave', () => {
      if (focusedDay !== null) showTooltip(focusedDay, series, days)
      else el('tooltip').hidden = true
    })
    root.append(hit)
  })
  root.append(svg('line', {x1: margin.left, x2: width - margin.right, y1: y(0), y2: y(0), class: 'baseline'}))
  chart.replaceChildren(root)

  const peak = days.reduce((best, d) => d.total > best.total ? d : best, days[0])
  chart.setAttribute('aria-label', `日別の積み上げ棒グラフ。${shortDay(days[0].day)}〜${shortDay(days.at(-1)!.day)}、` +
    `${metricLabel()}の合計 ${fmt(total)}。最も多いのは ${shortDay(peak.day)} の ${fmt(peak.total)}。` +
    '左右の矢印キーで日ごとの内訳を読み上げます。')
  if (focusedDay !== null && focusedDay < days.length) showTooltip(focusedDay, series, days)
}

function earliestRecordDay(): string | null {
  const values = [report!.earliest.claude, report!.earliest.codex].filter((v): v is number => v !== null)
  return values.length ? dayKey(Math.min(...values)) : null
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
  const notes: string[] = []
  if (day.unknownTokens > 0 && view.metric === 'cost') {
    notes.push(`料金不明 ${formatValue(day.unknownTokens, 'tokens')} トークン(合計に含めず)`)
  }
  if (view.metric === 'tokens' && !view.withCacheRead && day.cacheRead > 0) {
    notes.push(`キャッシュ読込 ${formatValue(day.cacheRead, 'tokens')}(含めず)`)
  }
  if (day.total === 0) notes.push('利用なし')
  for (const note of notes) tip.append(make('div', 'tip-note', note))
  tip.hidden = false
  // 指している棒を隠さないよう、棒の右(はみ出すなら左)に出す
  const chart = el('chart')
  const band = (Math.max(320, chart.clientWidth) - CHART_MARGIN.left - CHART_MARGIN.right) / days.length
  const center = chart.offsetLeft + CHART_MARGIN.left + band * (index + 0.5)
  const right = center + band / 2 + 8
  const fits = right + tip.offsetWidth <= chart.offsetLeft + chart.clientWidth
  tip.style.left = `${Math.max(chart.offsetLeft, fits ? right : center - band / 2 - 8 - tip.offsetWidth)}px`
  tip.style.top = `${chart.offsetTop + CHART_MARGIN.top}px`
  // キーボードで選んだ日は、ツールチップと同じ内容を読み上げる
  if (index === focusedDay) {
    el('chart-live').textContent = [head.textContent, ...rows.map(({s, value}) => `${s.name} ${fmt(value)}`), ...notes]
      .join('、')
  }
}

function renderDailyTable(series: Series[], days: DayStack[]): void {
  const host = el('daily-table')
  host.hidden = !showTable || !el('empty').hidden
  el('table-toggle').textContent = showTable ? 'グラフで見る' : '日別の表で見る'
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

function toggleFilter(id: string): void {
  filter = filter === id ? null : id
  focusedDay = null
  render()
  // 表は作り直されるので、押したボタンに焦点を戻す
  document.querySelector<HTMLButtonElement>(`.project-button[data-id="${CSS.escape(id)}"]`)?.focus()
}

function renderProjects(index: number | null): void {
  const r = report!
  const other: Metric = view.metric === 'cost' ? 'tokens' : 'cost'
  const otherView: ViewOptions = {metric: other, withCacheRead: false}
  const unit = view.metric === 'cost' ? '額' : 'トークン'
  el('col-main').textContent = metricLabel()
  el('col-claude').textContent = `Claude(${unit})`
  el('col-codex').textContent = `Codex(${unit})`
  el('col-other').textContent = other === 'cost' ? 'API換算額' : 'トークン'
  const slotOf = new Map<number, Series>()
  for (const s of buildSeries(r, view)) if (s.slot !== null) slotOf.set(s.projects[0], s)
  const order = r.projects.map((_, i) => i)
    .sort((a, b) => valueOf(projectAmount(r.projects[b]), view) - valueOf(projectAmount(r.projects[a]), view))
  const body = document.querySelector('#projects tbody')!
  if (!order.length) {
    const row = make('tr')
    const cell = make('td', 'empty-row', 'この期間の利用はありません。')
    cell.colSpan = 6
    row.append(cell)
    body.replaceChildren(row)
    return
  }
  body.replaceChildren(...order.map((i) => {
    const p = r.projects[i]
    const amount = projectAmount(p)
    const row = make('tr')
    if (index === i) row.classList.add('selected')
    const nameCell = make('th')
    nameCell.setAttribute('scope', 'row')
    const s = slotOf.get(i)
    const button = make('button', 'project-button')
    button.type = 'button'
    button.dataset.id = p.id
    button.setAttribute('aria-pressed', String(index === i))
    button.append(s ? swatch(s) : make('span', 'swatch empty-swatch'), make('span', 'project-name', p.name))
    button.addEventListener('click', () => toggleFilter(p.id))
    nameCell.append(button)
    if (p.path) nameCell.append(make('div', 'project-path', p.path))
    const value = (v: number, unknownTokens: number) => {
      const cell = make('td', 'num', view.metric === 'cost' ? fmt(v) : formatValue(v, 'tokens'))
      if (view.metric === 'cost' && unknownTokens > 0) cell.append(make('span', 'tag', '+料金不明'))
      return cell
    }
    row.append(
      nameCell,
      value(valueOf(amount, view), amount.unknownTokens),
      value(valueOf(p.claude, view), p.claude.unknownTokens),
      value(valueOf(p.codex, view), p.codex.unknownTokens),
      make('td', 'num', formatValue(valueOf(amount, otherView), other)),
      make('td', 'num', lastUsed(p.lastUsedAt)),
    )
    return row
  }))
}

function lastUsed(at: number): string {
  const d = new Date(at)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function renderStatus(): void {
  const r = report
  // 「n 分前」は時間とともに変わるため、読み上げ対象(role=status)の外に出す
  let updated = ''
  if (r?.lastScanAt) {
    const at = new Date(r.lastScanAt)
    updated = `最終更新 ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` +
      `(${relativeTime(r.lastScanAt, Date.now())})`
  }
  el('updated').textContent = updated
  const status = el('status')
  if (status.textContent !== statusMessage) status.textContent = statusMessage

  const notes: string[] = []
  if (r) {
    for (const agent of ['claude', 'codex'] as const) {
      const at = r.earliest[agent]
      if (at !== null && r.days[0] < dayKey(at)) notes.push(`${AGENT_LABELS[agent]} の記録は ${shortDay(dayKey(at))} 以降のみ`)
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
    `集計データは ${r.storagePath} に保存し、外部には送りません。保存するのはトークン数・モデル・時刻・作業フォルダと、重複を見分けるための ID・記録ファイルの場所で、会話本文は保存しません。Claude Code と Codex の元の記録が消えても集計は残ります。`,
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
  const id = filter
  filter = null
  render()
  // 解除ボタンは隠れるので、絞り込んでいたプロジェクトのボタンへ焦点を移す
  if (id) document.querySelector<HTMLButtonElement>(`.project-button[data-id="${CSS.escape(id)}"]`)?.focus()
})
el('table-toggle').addEventListener('click', () => {
  showTable = !showTable
  focusedDay = null
  render()
})
el('refresh').addEventListener('click', () => {
  statusMessage = ''
  renderStatus()
  api.refresh()
})
el('delete-data').addEventListener('click', () => {
  api.deleteData().catch(() => {
    statusMessage = '集計データを削除できませんでした。アプリを終了してから README の手順で削除してください。'
    renderStatus()
  })
})

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

el('notice-close').addEventListener('click', () => {
  el('notice').hidden = true
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
