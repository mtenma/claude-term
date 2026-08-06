import {Terminal} from '@xterm/xterm'
import {FitAddon} from '@xterm/addon-fit'
import {WebglAddon} from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import type {SessionInfo, SessionState, SessionsUpdate, TermOut} from '../shared/types'
import type {ClaudeTermApi} from '../preload/preload'

declare global {
  interface Window {
    claudeTerm: ClaudeTermApi
  }
}

const api = window.claudeTerm

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
term.open(host)
try {
  const webgl = new WebglAddon()
  webgl.onContextLoss(() => webgl.dispose())
  term.loadAddon(webgl)
} catch {
  // WebGL が使えない環境では DOM レンダラーで続行
}

// 改行支援のため「直前に打った文字がスペースか」を追跡する
let lastTypedWasSpace = false
term.onData((d) => {
  lastTypedWasSpace = d.endsWith(' ')
  api.termInput(d)
})

// claude 実行中のセッションでのみ有効な改行支援:
//   行末スペース + Enter → スペースを消して \ + Enter(claude の改行)
//   Shift + Enter        → \ + Enter
// 通常のシェルでは介入しない。IME 変換中の Enter にも介入しない。
function activeClaude(): boolean {
  return sessions.find((s) => s.id === activeId)?.claudeActive ?? false
}
term.attachCustomKeyEventHandler((ev) => {
  if (ev.type !== 'keydown') return true
  if (ev.isComposing || ev.keyCode === 229) return true
  if (ev.key !== 'Enter' || ev.ctrlKey || ev.metaKey || ev.altKey) return true
  if (!activeClaude()) return true
  if (ev.shiftKey) {
    api.termInput('\\\r')
    lastTypedWasSpace = false
    return false
  }
  if (lastTypedWasSpace) {
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

// ---- サイドバー ----

let sessions: SessionInfo[] = []
let activeId: string | null = null

function applyUpdate(u: SessionsUpdate): void {
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
    activeId = s.id
    api.attachSession(s.id)
    term.focus()
    renderList()
  })
  return card
}

newBtn.addEventListener('click', () => {
  void api.createSession().then(() => term.focus())
})

api.onSessionsUpdate(applyUpdate)
void api.requestSessions().then(applyUpdate)

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
