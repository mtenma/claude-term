import {execFile} from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn, type IPty} from 'node-pty'
import {Terminal} from '@xterm/headless'
import {SerializeAddon} from '@xterm/addon-serialize'
import type {SessionInfo, SessionState, SessionsUpdate, TermOut} from '../shared/types'

const PREVIEW_LINES = 5
const PREVIEW_SCAN_LIMIT = 200
const ACTIVITY_WINDOW_MS = 2500
const HOOK_RUNNING_STALE_MS = 60_000
const TICK_MS = 700
const CWD_POLL_MS = 2000
const SCROLLBACK = 3000
const SNAPSHOT_SCROLLBACK = 2000
// フロー制御: renderer が未消化のバイト数(UTF-16 長)がこの閾値を超えたら PTY を止める
const HIGH_WATER = 1_000_000
const LOW_WATER = 250_000

type HookState = 'running' | 'attention' | 'idle'

interface Session {
  id: string
  index: number
  cwd: string
  pty: IPty
  term: Terminal
  serialize: SerializeAddon
  // detach 中に DA1/DSR 等の端末クエリへ headless が応答するための購読。
  // attach 中は renderer の xterm が応答者になるため解除する(二重応答防止)
  answerback: {dispose(): void} | null
  exited: boolean
  // attach のセンチネル完了までに到着した PTY データの一時置き場
  pendingDuringAttach: string[] | null
  hookState: HookState | null
  hookStateAt: number
  lastOutputAt: number
  bellAt: number
  paused: boolean
  lastLoggedState: SessionState | null
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private counter = 0
  private cols = 80
  private rows = 24
  private attachEpoch = 0
  private unackedBytes = 0
  private lastEmitted = ''
  activeId: string | null = null

  onSessionsUpdate: (update: SessionsUpdate) => void = () => {}
  onTermOut: (payload: TermOut) => void = () => {}

  constructor(private hookPort: number) {
    setInterval(() => this.emitIfChanged(false), TICK_MS).unref()
    // シェルの現在ディレクトリを追跡してカードタイトルに反映する
    setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.exited) this.refreshCwd(s)
      }
    }, CWD_POLL_MS).unref()
  }

  create(): SessionInfo {
    const index = ++this.counter
    const id = `s${index}`
    const shell = process.env.SHELL || '/bin/zsh'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v === undefined) continue
      // アプリ自体が Claude Code セッション内から起動された場合でも、
      // 中のシェルの claude がネスト実行と誤認しないよう継承させない
      if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) continue
      env[k] = v
    }
    delete env.ELECTRON_RUN_AS_NODE
    env.LANG = env.LANG || 'ja_JP.UTF-8'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'claude-term'
    env.CLAUDE_TERM_SESSION = id
    env.CLAUDE_TERM_PORT = String(this.hookPort)

    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: os.homedir(),
      env,
    })
    const term = new Terminal({
      cols: this.cols,
      rows: this.rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    })
    const serialize = new SerializeAddon()
    // SerializeAddon は DOM 非依存で headless 動作が想定されている(VS Code と同構成)
    term.loadAddon(serialize as unknown as Parameters<Terminal['loadAddon']>[0])

    const session: Session = {
      id,
      index,
      cwd: os.homedir(),
      pty,
      term,
      serialize,
      answerback: null,
      exited: false,
      pendingDuringAttach: null,
      hookState: null,
      hookStateAt: 0,
      lastOutputAt: Date.now(),
      bellAt: 0,
      paused: false,
      lastLoggedState: null,
    }
    this.enableAnswerback(session)
    term.onBell(() => {
      if (this.activeId !== session.id) session.bellAt = Date.now()
    })
    // OSC 9 (iTerm 系の通知シーケンス) も要注目として拾う
    term.parser.registerOscHandler(9, () => {
      if (this.activeId !== session.id) session.bellAt = Date.now()
      return true
    })
    // OSC 7 (シェル統合の cwd 通知) があれば即時にタイトルへ反映
    term.parser.registerOscHandler(7, (data) => {
      try {
        const u = new URL(data)
        if (u.protocol === 'file:' && u.pathname) {
          session.cwd = decodeURIComponent(u.pathname)
        }
      } catch {
        // 不正な URL は無視
      }
      return true
    })
    pty.onData((data) => this.handlePtyData(session, data))
    pty.onExit(() => {
      session.exited = true
      this.disableAnswerback(session)
      this.emitIfChanged(true)
    })

    this.sessions.set(id, session)
    this.emitIfChanged(true)
    return this.toInfo(session)
  }

  /**
   * セッションをメイン表示に切り替える。
   * xterm の write は非同期のため、空 write のコールバック(センチネル)で
   * 「それ以前の全データがパース済み」の瞬間を捉えて serialize する。
   * センチネル待ちの間に届いたデータは pendingDuringAttach に溜めて直後に flush し、
   * スナップショットとの欠落・重複をゼロにする。
   */
  attach(id: string): void {
    const next = this.sessions.get(id)
    if (!next) return
    if (this.activeId && this.activeId !== id) {
      const prev = this.sessions.get(this.activeId)
      if (prev) {
        this.enableAnswerback(prev)
        this.resumeIfPaused(prev)
        prev.pendingDuringAttach = null
      }
    }
    this.activeId = id
    next.bellAt = 0
    next.pendingDuringAttach = []
    const epoch = ++this.attachEpoch
    next.term.write('', () => {
      if (this.attachEpoch !== epoch || this.activeId !== id) return
      this.disableAnswerback(next)
      const snapshot = next.serialize.serialize({scrollback: SNAPSHOT_SCROLLBACK})
      this.unackedBytes = 0
      this.emitToRenderer(next, {kind: 'snapshot', id, data: snapshot})
      const pending = next.pendingDuringAttach ?? []
      next.pendingDuringAttach = null
      for (const chunk of pending) {
        this.emitToRenderer(next, {kind: 'data', id, data: chunk})
      }
    })
    this.emitIfChanged(true)
  }

  inputToActive(data: string): void {
    if (!this.activeId) return
    const s = this.sessions.get(this.activeId)
    if (!s || s.exited) return
    s.bellAt = 0
    s.pty.write(data)
  }

  /** デモ・検証用: 任意セッションへの直接入力 */
  writeTo(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s && !s.exited) s.pty.write(data)
  }

  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    if (!s.exited) {
      try {
        s.pty.kill()
      } catch {
        // 既に死んでいる場合は無視
      }
    }
    this.disableAnswerback(s)
    s.term.dispose()
    this.sessions.delete(id)
    if (this.activeId === id) this.activeId = null
    this.emitIfChanged(true)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    // 全セッションをメイン表示の寸法に常時揃える(attach 時の再折返し崩れを防ぐ)。
    // headless を先に resize してから PTY に伝える
    for (const s of this.sessions.values()) {
      s.term.resize(cols, rows)
      if (!s.exited) {
        try {
          s.pty.resize(cols, rows)
        } catch {
          // race で死んでいたら無視
        }
      }
    }
  }

  ack(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < 0) return
    this.unackedBytes = Math.max(0, this.unackedBytes - bytes)
    if (this.unackedBytes < LOW_WATER && this.activeId) {
      const s = this.sessions.get(this.activeId)
      if (s) this.resumeIfPaused(s)
    }
  }

  setHookState(id: string, state: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.hookState = state === 'clear' ? null : (state as HookState)
    s.hookStateAt = Date.now()
    this.emitIfChanged(true)
  }

  hasLive(): boolean {
    for (const s of this.sessions.values()) {
      if (!s.exited) return true
    }
    return false
  }

  currentUpdate(): SessionsUpdate {
    return {
      sessions: [...this.sessions.values()].map((s) => this.toInfo(s)),
      activeId: this.activeId,
    }
  }

  /** 検証用: ミラーの現在画面を直列化して返す */
  serializeSession(id: string): string | null {
    const s = this.sessions.get(id)
    return s ? s.serialize.serialize({scrollback: SNAPSHOT_SCROLLBACK}) : null
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      if (!s.exited) {
        try {
          s.pty.kill()
        } catch {
          // 無視
        }
      }
      this.disableAnswerback(s)
      s.term.dispose()
    }
    this.sessions.clear()
    this.activeId = null
  }

  private handlePtyData(s: Session, data: string): void {
    s.lastOutputAt = Date.now()
    s.term.write(data)
    if (this.activeId === s.id) {
      if (s.pendingDuringAttach) s.pendingDuringAttach.push(data)
      else this.emitToRenderer(s, {kind: 'data', id: s.id, data})
    }
  }

  private emitToRenderer(s: Session, payload: TermOut): void {
    this.onTermOut(payload)
    this.unackedBytes += payload.data.length
    if (!s.paused && this.unackedBytes > HIGH_WATER) {
      s.paused = true
      try {
        s.pty.pause()
        console.log(`[flow] pause ${s.id} unacked=${this.unackedBytes}`)
      } catch {
        s.paused = false
      }
    }
  }

  private resumeIfPaused(s: Session): void {
    if (!s.paused) return
    s.paused = false
    try {
      s.pty.resume()
      console.log(`[flow] resume ${s.id}`)
    } catch {
      // 無視
    }
  }

  private enableAnswerback(s: Session): void {
    if (s.answerback) return
    s.answerback = s.term.onData((d) => {
      if (!s.exited) s.pty.write(d)
    })
  }

  private disableAnswerback(s: Session): void {
    s.answerback?.dispose()
    s.answerback = null
  }

  private stateOf(s: Session): SessionState {
    if (s.exited) return 'exited'
    const now = Date.now()
    if (s.hookState === 'attention') return 'attention'
    if (s.hookState === 'idle') return 'idle'
    if (s.hookState === 'running') {
      // クラッシュ等で SessionEnd が発火しなかった場合の固着防止
      if (now - Math.max(s.hookStateAt, s.lastOutputAt) < HOOK_RUNNING_STALE_MS) return 'running'
    }
    if (s.bellAt && this.activeId !== s.id) return 'attention'
    if (now - s.lastOutputAt < ACTIVITY_WINDOW_MS) return 'running'
    return 'idle'
  }

  private previewOf(s: Session): string[] {
    const buf = s.term.buffer.active
    const lines: string[] = []
    const bottom = buf.length - 1
    const limit = Math.max(0, buf.length - PREVIEW_SCAN_LIMIT)
    for (let y = bottom; y >= limit && lines.length < PREVIEW_LINES; y--) {
      const line = buf.getLine(y)
      if (!line) continue
      const text = line.translateToString(true)
      if (lines.length === 0 && text.trim() === '') continue
      lines.unshift(text)
    }
    return lines
  }

  /** シェルプロセスの現在の作業ディレクトリを lsof で取得(macOS、失敗は無視) */
  private refreshCwd(s: Session): void {
    execFile(
      '/usr/sbin/lsof',
      ['-a', '-p', String(s.pty.pid), '-d', 'cwd', '-Fn'],
      {timeout: 3000},
      (err, stdout) => {
        if (err || s.exited) return
        const line = stdout.split('\n').find((l) => l.startsWith('n'))
        if (line && line.length > 1) s.cwd = line.slice(1)
      },
    )
  }

  private toInfo(s: Session): SessionInfo {
    const home = os.homedir()
    const title = s.cwd === home ? '~' : path.basename(s.cwd) || s.cwd
    const abbrev = s.cwd.startsWith(home) ? `~${s.cwd.slice(home.length)}` : s.cwd
    return {
      id: s.id,
      title,
      cwd: `ターミナル${s.index} — ${abbrev}`,
      state: this.stateOf(s),
      preview: this.previewOf(s),
    }
  }

  private emitIfChanged(force: boolean): void {
    const update = this.currentUpdate()
    for (const info of update.sessions) {
      const s = this.sessions.get(info.id)
      if (s && s.lastLoggedState !== info.state) {
        console.log(`[state] ${info.id} ${s.lastLoggedState ?? 'new'} -> ${info.state}`)
        s.lastLoggedState = info.state
      }
    }
    const key = JSON.stringify(update)
    if (!force && key === this.lastEmitted) return
    this.lastEmitted = key
    this.onSessionsUpdate(update)
  }
}
