import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {WebglAddon} from '@xterm/addon-webgl'
import {SearchAddon} from '@xterm/addon-search'
import {WebLinksAddon} from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import {
  DEFAULT_APPEARANCE,
  AGENT_LABELS,
  type AppearanceSettings,
  type SessionInfo,
  type SessionState,
  type SessionsUpdate,
} from '../shared/types'
import type {ClaudeTermApi} from '../preload/preload'
import {resizeTerminal} from '../shared/terminalResize'
import {TerminalStream} from './terminalStream'

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
  unknown: '状態未取得',
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
  // tmux の mouse on 等でマウスがアプリに奪われていても ⌥ドラッグでローカル選択できるようにする
  macOptionClickForcesSelection: true,
  // OSC 8 のリンク。xterm の既定は URL なしの window.open() で開くため、Electron の窓を作らず
  // 表示中の URL と同じく ⌘ クリックで既定のブラウザに渡す(http(s) 以外は main 側で開かない)
  linkHandler: {
    activate: (ev, uri) => {
      if (ev.metaKey) api.openExternal(uri)
    },
  },
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

// devshot(検証シナリオ)から xterm 内部の寸法を覗くためのフック
;(window as unknown as {__term: Terminal}).__term = term

// WebGL レンダラーは透過背景を描けないため、外観設定(透過)に応じて付け外しする。
// WebGL と DOM ではセル幅の計算(デバイスピクセル丸め)が僅かに異なり列数も変わるため、
// レンダラーが実際に切り替わったら必ず applyFit() で列数を再計算する。
// これを怠ると、切替前の列数のまま新レンダラーのセル幅で描画され、
// グリッドがホストからはみ出して右端の文字が欠ける(または右に余白が残る)
let webgl: WebglAddon | null = null
function setWebglEnabled(on: boolean): boolean {
  if (on && webgl === null) {
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        webgl = null
        refitForRendererChange() // DOM レンダラーへのフォールバックでセル幅が変わる
      })
      term.loadAddon(addon)
      webgl = addon
      return true
    } catch {
      webgl = null // WebGL が使えない環境では DOM レンダラーで続行
      return false
    }
  }
  if (!on && webgl !== null) {
    try {
      webgl.dispose()
    } catch {
      // dispose の失敗はレンダラー切替を妨げない
    }
    webgl = null
    return true
  }
  return false
}

// レンダラー交換直後は xterm 内部のセル寸法の更新が次フレームへ遅れることがあるため、
// 即時と次フレームの2回 fit して列数の再計算を確実にする
function refitForRendererChange(): void {
  applyFit()
  requestAnimationFrame(applyFit)
}

// 改行支援のため「直前に打った文字がスペースか」を追跡する
const stream = new TerminalStream(term, api.termInput, api.termAck, (id) => {
  // 新しい端末モードを復元してから、そのセッションへ focus reporting を送る。
  if (id === activeId) term.focus()
})
let lastTypedWasSpace = false
term.onData((d) => {
  lastTypedWasSpace = d.endsWith(' ')
  stream.input(d)
})

// 改行支援:
//   Shift + Enter → claude 実行中は \ + Enter(claude の改行記法)、
//                   それ以外は LF(= Ctrl+J。codex 等の TUI が改行として解釈)
//   行末スペース + Enter → claude 実行中のみ、スペースを消して \ + Enter
// IME 変換中の Enter/Shift+Enter は xterm に処理させない(確定は IME 側で行われ、
// テキストは composition イベント経由で届く)。xterm に渡すと CompositionHelper が
// 変換確定後に keydown を通常キーとして処理し、素の \r が送信されてしまう
function activeClaude(): boolean {
  return sessions.find((s) => s.id === stream.displayedId)?.activeAgent === 'claude'
}
term.attachCustomKeyEventHandler((ev) => {
  // Enter の keypress は常に xterm に処理させない。keydown をこのハンドラで横取り
  // した場合や IME 経由(keyCode 229)の場合、xterm 内部では keydown が「未処理」の
  // 扱いになり、後続の keypress から素の \r が二重送信されてしまう
  // (通常の Enter は keydown 側で送信されるため keypress を止めても影響しない)
  if (ev.type === 'keypress' && ev.key === 'Enter') return false
  if (ev.type !== 'keydown') return true
  if (ev.isComposing || ev.keyCode === 229) return ev.key !== 'Enter'
  if (ev.key !== 'Enter' || ev.ctrlKey || ev.metaKey || ev.altKey) return true
  const claude = activeClaude()
  if (ev.shiftKey) {
    stream.input(claude ? '\\\r' : '\n')
    lastTypedWasSpace = false
    return false
  }
  if (claude && lastTypedWasSpace) {
    stream.input('\x7f\\\r')
    lastTypedWasSpace = false
    return false
  }
  return true
})

// データのパースと寸法変更を同じ順序で処理する。write は非同期なので、
// リサイズや reset を先に実行すると、旧寸法向けの出力で文字が上書きされる。
api.onTermOut((p) => {
  void stream.accept(p).catch((error) => console.error('[terminal] 出力処理に失敗:', error))
})

// ---- リサイズ ----

let resizeFrame: number | undefined
let requestedCols = 0
let requestedRows = 0
function applyFit(): void {
  const dimensions = fit.proposeDimensions()
  if (!dimensions || dimensions.cols < 2 || dimensions.rows < 2 ||
      !Number.isFinite(dimensions.cols) || !Number.isFinite(dimensions.rows)) return
  if (dimensions.cols !== requestedCols || dimensions.rows !== requestedRows) {
    requestedCols = dimensions.cols
    requestedRows = dimensions.rows
    // 実際の変更は main が出力ストリームに挿入する resize 通知で行う。
    // セッションが無いときだけ空の画面をここで合わせる。
    if (!activeId && !stream.busy) resizeTerminal(term, dimensions.cols, dimensions.rows)
    api.termResize(dimensions.cols, dimensions.rows)
  }
}
new ResizeObserver(() => {
  if (resizeFrame !== undefined) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = undefined
    applyFit()
  })
}).observe(host)
requestAnimationFrame(applyFit)

// モニタ間移動などで devicePixelRatio が変わるとセル幅の計算も変わるが、
// ホスト要素の CSS サイズは変わらず ResizeObserver では検知できないため個別に監視する
function watchDpr(): void {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      applyFit()
      watchDpr()
    },
    {once: true},
  )
}
watchDpr()

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

function closeSearch(refocus = true): void {
  if (searchBar.classList.contains('hidden')) return
  search.clearDecorations()
  searchCount.textContent = ''
  searchBar.classList.add('hidden')
  if (refocus) term.focus()
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
el<HTMLButtonElement>('search-close').addEventListener('click', () => closeSearch())

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
  if (setWebglEnabled(!translucent)) refitForRendererChange()
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
  if (u.activeId !== activeId) closeSearch(false)
  sessions = u.sessions
  activeId = u.activeId
  if (activeId === null) {
    void stream.accept(null).catch((error) => console.error('[terminal] 画面消去に失敗:', error))
  }
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
  // renderList() はカードを毎回作り直すため、CSS アニメーションが更新のたびに
  // 先頭へ戻ってしまう。起動からの経過時間を負の animation-delay として与え、
  // 再構築をまたいでも位相が連続して見えるようにする(実行中の常時アニメ用)
  card.style.setProperty('--anim-epoch', `-${performance.now()}ms`)
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
  if (s.state === 'attention' && s.attentionMessage) state.title = s.attentionMessage
  if (s.state === 'unknown' && s.activeAgent === 'codex') {
    state.title = 'Codex は起動しています。状態・モデル・使用量を取得するには、Codex の /hooks で Claude Term の通知を有効にしてください。'
  }

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

  card.append(head)
  if (s.activeAgent) {
    const details = document.createElement('div')
    details.className = 'card-details'
    const agent = document.createElement('div')
    agent.className = 'card-agent'
    agent.textContent = AGENT_LABELS[s.activeAgent]
    details.append(agent)
    if (s.metrics?.model) {
      const model = document.createElement('span')
      model.className = 'card-model'
      model.textContent = s.metrics.model
      model.title = s.metrics.model
      details.append(model)
    }
    card.append(details)
  }
  if (s.activeAgent && s.metrics) {
    const metrics = document.createElement('div')
    metrics.className = 'card-metrics'
    const bits: string[] = []
    if (s.metrics.contextPct !== undefined) bits.push(`コンテキスト残${s.activeAgent === 'codex' ? '約' : ''}${s.metrics.contextPct}%`)
    if (s.metrics.totalTokens !== undefined) bits.push(`累計${s.metrics.totalTokens.toLocaleString('en-US')} tok`)
    for (const limit of s.metrics.rateLimits ?? []) {
      const minutes = limit.windowMinutes
      const label = minutes === 10080 ? '週間' : minutes % 1440 === 0 ? `${minutes / 1440}日` :
        minutes % 60 === 0 ? `${minutes / 60}時間` : `${minutes}分`
      bits.push(`${label}残${limit.remainingPct}%`)
    }
    if (s.metrics.costUsd !== undefined) bits.push(`$${s.metrics.costUsd.toFixed(2)}`)
    for (const bit of bits) {
      const item = document.createElement('span')
      item.textContent = bit
      item.title = bit
      metrics.append(item)
    }
    if (s.metrics.contextPct !== undefined && s.metrics.contextPct <= 20) {
      metrics.classList.add('warn')
    }
    if (bits.length) card.append(metrics)
  }
  if (!s.activeAgent) {
    const preview = document.createElement('pre')
    preview.className = 'card-preview'
    preview.textContent = s.preview.join('\n')
    card.append(preview)
  }
  card.addEventListener('click', () => {
    if (s.id === activeId) {
      term.focus()
      return
    }
    closeSearch(false)
    // focus-out は接続先を変える前のセッションへ届ける
    term.blur()
    lastTypedWasSpace = false
    activeId = s.id
    api.attachSession(s.id)
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

async function createSession(): Promise<void> {
  newBtn.disabled = true
  term.blur()
  lastTypedWasSpace = false
  // 新セッションは snapshot 復元後に onTermOut から focus する
  try {
    await api.createSession()
  } catch {
    window.alert('セッションを起動できませんでした。もう一度お試しください。')
    term.focus()
  } finally {
    newBtn.disabled = false
  }
}
newBtn.addEventListener('click', () => void createSession())

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
