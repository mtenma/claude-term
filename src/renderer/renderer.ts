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

// ---- サイドバー ----

let sessions: SessionInfo[] = []
let activeId: string | null = null

function applyUpdate(u: SessionsUpdate): void {
  // ドラッグ中の再描画は DnD を中断させるため見送る(確定時に main から強制更新が届く)
  if (draggingId !== null) return
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
