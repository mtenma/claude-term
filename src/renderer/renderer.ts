import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {WebglAddon} from '@xterm/addon-webgl'
import {SearchAddon} from '@xterm/addon-search'
import {WebLinksAddon} from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import {
  DEFAULT_APPEARANCE,
  type AppearanceSettings,
  type SessionInfo,
  type SessionState,
  type SessionsUpdate,
  type TermOut,
} from '../shared/types'
import type {ClaudeTermApi} from '../preload/preload'

declare global {
  interface Window {
    claudeTerm: ClaudeTermApi
  }
}

const api = window.claudeTerm

let appearance: AppearanceSettings = DEFAULT_APPEARANCE

const STATE_LABELS: Record<SessionState, string> = {
  running: '実行中',
  attention: '承認待ち',
  idle: '待機',
  exited: '終了',
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing element #${id}`)
  return node as T
}

const host = el<HTMLDivElement>('term-host')
const placeholder = el<HTMLDivElement>('placeholder')
const listEl = el<HTMLDivElement>('session-list')
const newBtn = el<HTMLButtonElement>('new-btn')
const sidebar = el<HTMLElement>('sidebar')
const splitter = el<HTMLDivElement>('splitter')

// ---- メインターミナル ----

const term = new Terminal({
  fontSize: 13,
  fontFamily: 'Menlo, Monaco, "SF Mono", "Hiragino Sans", monospace',
  lineHeight: 1.1,
  scrollback: 5000,
  cursorBlink: true,
  allowProposedApi: true,
  allowTransparency: true,
  theme: {
    background: '#0f0f11',
    foreground: '#e4e4e7',
    cursor: '#22c55e',
    cursorAccent: '#0f0f11',
    selectionBackground: '#3f3f46',
  },
})
const fit = new FitAddon()
term.loadAddon(fit)
const search = new SearchAddon()
term.loadAddon(search)
// URL は誤クリック防止のため ⌘ クリックでのみ開く(iTerm 等の作法)
term.loadAddon(
  new WebLinksAddon((ev, uri) => {
    if (ev.metaKey) api.openExternal(uri)
  }),
)
term.open(host)

// WebGL レンダラーは透過背景を描けないため、外観設定(透過)に応じて付け外しする
let webgl: WebglAddon | null = null
function setWebglEnabled(on: boolean): void {
  if (on && webgl === null) {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch {
      webgl = null // WebGL が使えない環境では DOM レンダラーで続行
    }
  } else if (!on && webgl !== null) {
    try {
      webgl.dispose()
    } catch {
      // dispose の失敗はレンダラー切替を妨げない
    }
    webgl = null
  }
}

// 改行支援のため「直前に打った文字がスペースか」を追跡する
let lastTypedWasSpace = false
term.onData((d) => {
  lastTypedWasSpace = d.endsWith(' ')
  api.termInput(d)
})

// 改行支援:
//   Shift + Enter → claude 実行中は \ + Enter(claude の改行記法)、
//                   それ以外は LF(= Ctrl+J。codex 等の TUI が改行として解釈)
//   行末スペース + Enter → claude 実行中のみ、スペースを消して \ + Enter
// IME 変換中の Enter には介入しない。
function activeClaude(): boolean {
  return sessions.find((s) => s.id === activeId)?.claudeActive ?? false
}
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') return true
  if (ev.isComposing || ev.keyCode === 229) return true
  if (ev.key !== 'Enter' || ev.ctrlKey || ev.metaKey || ev.altKey) return true
  const claude = activeClaude()
  if (ev.shiftKey) {
    api.termInput(claude ? '\\\r' : '\n')
    lastTypedWasSpace = false
    return false
  }
  if (claude && lastTypedWasSpace) {
    api.termInput('\x7f\\\r')
    lastTypedWasSpace = false
    return false
  }
  return true
})

api.onTermOut((p: TermOut) => {
  if (p.kind === 'snapshot') term.reset()
  term.write(p.data, () => api.termAck(p.data.length))
})

// ---- リサイズ ----

let resizeTimer: number | undefined
function applyFit(): void {
  try {
    fit.fit()
  } catch {
    return
  }
  if (term.cols > 1 && term.rows > 1) api.termResize(term.cols, term.rows)
}
new ResizeObserver(() => {
  window.clearTimeout(resizeTimer)
  resizeTimer = window.setTimeout(applyFit, 150)
}).observe(host)
requestAnimationFrame(applyFit)

// ---- ターミナル内検索 (⌘F) ----

const searchBar = el<HTMLDivElement>('search-bar')
const searchInput = el<HTMLInputElement>('search-input')
const searchCount = el<HTMLSpanElement>('search-count')

const searchDecorations = () => ({
  matchBackground: '#3f3f46',
  matchOverviewRuler: '#6b6b74',
  activeMatchBackground: appearance.accent,
  activeMatchColorOverviewRuler: appearance.accent,
})

search.onDidChangeResults(({resultIndex, resultCount}) => {
  if (searchInput.value === '') searchCount.textContent = ''
  else if (resultCount <= 0) searchCount.textContent = '0件'
  else searchCount.textContent = `${resultIndex + 1}/${resultCount}`
})

function doSearch(dir: 'next' | 'prev', incremental = false): void {
  const q = searchInput.value
  if (q === '') {
    search.clearDecorations()
    searchCount.textContent = ''
    return
  }
  const opts = {incremental, decorations: searchDecorations()}
  if (dir === 'next') search.findNext(q, opts)
  else search.findPrevious(q, opts)
}

function openSearch(): void {
  searchBar.classList.remove('hidden')
  searchInput.focus()
  searchInput.select()
  if (searchInput.value !== '') doSearch('next', true)
}

function closeSearch(): void {
  if (searchBar.classList.contains('hidden')) return
  search.clearDecorations()
  searchCount.textContent = ''
  searchBar.classList.add('hidden')
  term.focus()
}

searchInput.addEventListener('input', () => doSearch('next', true))
searchInput.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return
  if (ev.key === 'Enter') {
    ev.preventDefault()
    doSearch(ev.shiftKey ? 'prev' : 'next')
  } else if (ev.key === 'Escape') {
    ev.preventDefault()
    closeSearch()
  }
})
el<HTMLButtonElement>('search-prev').addEventListener('click', () => doSearch('prev'))
el<HTMLButtonElement>('search-next').addEventListener('click', () => doSearch('next'))
el<HTMLButtonElement>('search-close').addEventListener('click', closeSearch)

api.onFind(openSearch)

// ---- 外観設定 ----

const settingsOverlay = el<HTMLDivElement>('settings-overlay')
const setOpacity = el<HTMLInputElement>('set-opacity')
const setOpacityVal = el<HTMLSpanElement>('set-opacity-val')
const setBg = el<HTMLInputElement>('set-bg')
const setFg = el<HTMLInputElement>('set-fg')
const setAccent = el<HTMLInputElement>('set-accent')

function cssRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

function applyAppearance(a: AppearanceSettings): void {
  appearance = a
  const root = document.documentElement.style
  root.setProperty('--bg', a.background)
  root.setProperty('--text', a.foreground)
  root.setProperty('--accent', a.accent)
  root.setProperty('--bg-pct', `${a.opacity}%`)
  const translucent = a.opacity < 100
  // 透過時はターミナル自身の背景を消して body の半透明背景を透かす
  term.options.theme = {
    ...term.options.theme,
    background: translucent ? cssRgba(a.background, 0) : a.background,
    foreground: a.foreground,
    cursorAccent: a.background,
  }
  // WebGL レンダラーは透過背景に対応しないため DOM レンダラーへ切り替える
  // (テーマ適用の後に行い、切替の失敗が配色へ波及しないようにする)
  setWebglEnabled(!translucent)
  setOpacity.value = String(a.opacity)
  setOpacityVal.textContent = `${a.opacity}%`
  setBg.value = a.background
  setFg.value = a.foreground
  setAccent.value = a.accent
}

function collectAppearance(): AppearanceSettings {
  return {
    opacity: Number(setOpacity.value),
    background: setBg.value,
    foreground: setFg.value,
    accent: setAccent.value,
  }
}

for (const input of [setOpacity, setBg, setFg, setAccent]) {
  input.addEventListener('input', () => {
    const a = collectAppearance()
    applyAppearance(a)
    api.setSettings(a)
  })
}

el<HTMLButtonElement>('settings-reset').addEventListener('click', () => {
  applyAppearance(DEFAULT_APPEARANCE)
  api.setSettings(DEFAULT_APPEARANCE)
})

function closeSettings(): void {
  settingsOverlay.classList.add('hidden')
  term.focus()
}

el<HTMLButtonElement>('settings-close').addEventListener('click', closeSettings)
settingsOverlay.addEventListener('mousedown', (e) => {
  if (e.target === settingsOverlay) closeSettings()
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsOverlay.classList.contains('hidden')) closeSettings()
})

api.onOpenSettings(() => settingsOverlay.classList.remove('hidden'))
api.onSettingsUpdate((a) => {
  // 自分の変更のエコーバックは適用済みなのでスキップ(他ウィンドウ発の変更だけ反映)
  if (JSON.stringify(a) !== JSON.stringify(appearance)) applyAppearance(a)
})
void api.getSettings().then(applyAppearance)

// ---- サイドバー ----

let sessions: SessionInfo[] = []
let activeId: string | null = null

function applyUpdate(u: SessionsUpdate): void {
  // ドラッグ中の再描画は DnD を中断させるため見送る(確定時に main から強制更新が届く)
  if (draggingId !== null) return
  // 表示セッションが変わったら検索状態は持ち越さない
  if (u.activeId !== activeId) closeSearch()
  sessions = u.sessions
  activeId = u.activeId
  if (activeId === null) term.reset()
  placeholder.classList.toggle('hidden', sessions.length > 0)
  renderList()
}

function renderList(): void {
  listEl.textContent = ''
  for (const s of sessions) {
    listEl.appendChild(buildCard(s))
  }
}

function buildCard(s: SessionInfo): HTMLElement {
  const card = document.createElement('div')
  card.className = `card ${s.state}${s.id === activeId ? ' selected' : ''}`
  card.dataset.id = s.id
  card.draggable = true
  card.addEventListener('dragstart', (e) => {
    draggingId = s.id
    e.dataTransfer?.setData('text/plain', s.id)
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    // 即クラスを付けるとドラッグゴースト画像まで薄くなるため、キャプチャ後に付ける
    requestAnimationFrame(() => card.classList.add('dragging'))
  })
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging')
    draggingId = null
    const order = [...listEl.querySelectorAll<HTMLElement>('.card')]
      .map((c) => c.dataset.id ?? '')
      .filter((id) => id !== '')
    api.reorderSessions(order)
  })

  const head = document.createElement('div')
  head.className = 'card-head'

  const title = document.createElement('span')
  title.className = 'card-title'
  title.textContent = s.title
  title.title = s.cwd

  const state = document.createElement('span')
  state.className = `card-state ${s.state}`
  state.textContent = STATE_LABELS[s.state]

  const close = document.createElement('button')
  close.className = 'card-close'
  close.title = 'セッションを閉じる'
  close.textContent = '×'
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    if (s.state === 'exited' || window.confirm(`${s.title} を閉じますか?実行中の処理は終了します。`)) {
      void api.killSession(s.id)
    }
  })

  head.append(title, state, close)

  const preview = document.createElement('pre')
  preview.className = 'card-preview'
  preview.textContent = s.preview.join('\n')

  card.append(head)
  if (s.state === 'attention' && s.attentionMessage) {
    const msg = document.createElement('div')
    msg.className = 'card-attn-msg'
    msg.textContent = s.attentionMessage
    card.append(msg)
  }
  if (s.metrics && (s.metrics.model || s.metrics.contextPct !== undefined || s.metrics.costUsd !== undefined)) {
    const metrics = document.createElement('div')
    metrics.className = 'card-metrics'
    const bits: string[] = []
    if (s.metrics.model) bits.push(s.metrics.model)
    if (s.metrics.contextPct !== undefined) bits.push(`コンテキスト残${s.metrics.contextPct}%`)
    if (s.metrics.costUsd !== undefined) bits.push(`$${s.metrics.costUsd.toFixed(2)}`)
    metrics.textContent = bits.join(' · ')
    if (s.metrics.contextPct !== undefined && s.metrics.contextPct <= 20) {
      metrics.classList.add('warn')
    }
    card.append(metrics)
  }
  card.append(preview)
  card.addEventListener('click', () => {
    if (s.id === activeId) {
      term.focus()
      return
    }
    closeSearch()
    activeId = s.id
    api.attachSession(s.id)
    term.focus()
    renderList()
  })
  return card
}

// ---- セッションの並び替え(ドラッグ&ドロップ) ----

let draggingId: string | null = null

/** ドロップ先: マウス Y より下にある最初のカード(無ければ末尾) */
function dragAfterElement(y: number): HTMLElement | null {
  let closest: {offset: number; el: HTMLElement} | null = null
  for (const el of listEl.querySelectorAll<HTMLElement>('.card:not(.dragging)')) {
    const box = el.getBoundingClientRect()
    const offset = y - box.top - box.height / 2
    if (offset < 0 && (closest === null || offset > closest.offset)) closest = {offset, el}
  }
  return closest?.el ?? null
}

listEl.addEventListener('dragover', (e) => {
  if (draggingId === null) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  const dragging = listEl.querySelector<HTMLElement>('.card.dragging')
  if (!dragging) return
  const after = dragAfterElement(e.clientY)
  if (after === null) listEl.appendChild(dragging)
  else if (after !== dragging) listEl.insertBefore(dragging, after)
})

listEl.addEventListener('drop', (e) => {
  if (draggingId !== null) e.preventDefault()
})

newBtn.addEventListener('click', () => {
  void api.createSession().then(() => term.focus())
})

api.onSessionsUpdate(applyUpdate)
void api.requestSessions().then(applyUpdate)

// メニューの「すべてを選択」(⌘A) はターミナルの全バッファ選択として動かす
api.onSelectAll(() => {
  term.selectAll()
  term.focus()
})

// ---- サイドバー幅のドラッグ調整 ----

splitter.addEventListener('mousedown', (e) => {
  e.preventDefault()
  const startX = e.clientX
  const startW = sidebar.getBoundingClientRect().width
  document.body.classList.add('resizing')
  const move = (ev: MouseEvent) => {
    const w = Math.min(Math.max(startW + (startX - ev.clientX), 260), window.innerWidth * 0.6)
    sidebar.style.width = `${w}px`
  }
  const up = () => {
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})
