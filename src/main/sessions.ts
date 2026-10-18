import {execFile} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {spawn, type IPty} from 'node-pty'
import {Terminal} from '@xterm/headless'
import {SerializeAddon} from '@xterm/addon-serialize'
import type {AgentKind, SessionInfo, SessionMetrics, SessionState, SessionsUpdate, TermAck, TermInput, TermOut} from '../shared/types'
import {CodexActivity, parseCodexEvent} from './codexEvents'
import {configureShellIntegration} from './shellIntegration'
import {resizeTerminal} from '../shared/terminalResize'

const PREVIEW_LINES = 5
const PREVIEW_SCAN_LIMIT = 200
const ACTIVITY_WINDOW_MS = 2500
// リサイズ直後は SIGWINCH による再描画出力が届くため、活動判定から除外する猶予
const RESIZE_GRACE_MS = 1000
const HOOK_RUNNING_STALE_MS = 60_000
const SCREEN_SETTLE_MS = 100
const TICK_MS = 700
const CWD_POLL_MS = 2000
const SCROLLBACK = 3000
const SNAPSHOT_SCROLLBACK = 2000
// フロー制御: renderer が未消化のバイト数(UTF-16 長)がこの閾値を超えたら PTY を止める
const HIGH_WATER = 1_000_000
const LOW_WATER = 250_000
const SHELL_PROCESSES = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ash', 'ksh', 'csh', 'tcsh', 'nu', 'elvish', 'pwsh'])

type HookState = 'running' | 'attention' | 'idle'

// アプリ終了時に node-pty の onExit(ThreadSafeFunction)配送の完了を待つための追跡。
// 配送前に Node 環境の破棄が始まると pty.node が C++ 例外で abort する(macOS で SIGABRT)
let livePtyCount = 0
const ptyExitWaiters = new Set<() => void>()

function trackPtySpawn(): void {
  livePtyCount++
}

function trackPtyExit(): void {
  livePtyCount--
  if (livePtyCount <= 0) {
    for (const done of [...ptyExitWaiters]) done()
  }
}

/** 全 PTY の onExit が JS 側へ届くまで待つ(quit のゲート用。タイムアウトあり) */
export function whenAllPtysExited(timeoutMs: number): Promise<void> {
  if (livePtyCount <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      ptyExitWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(done, timeoutMs)
    ptyExitWaiters.add(done)
  })
}

/** hook の stdin JSON からイベント名や通知メッセージを取り出す */
function extractHookField(rawBody: string, field: string): string | null {
  if (!rawBody) return null
  try {
    const data = JSON.parse(rawBody) as Record<string, unknown>
    const message = data?.[field]
    if (typeof message === 'string' && message.trim() !== '') {
      return message.trim().slice(0, 200)
    }
  } catch {
    // JSON でなければ無視
  }
  return null
}

/** シグナル死したシェルの画面末尾に添える案内(薄い表示で本来の出力と区別する) */
function exitNotice(signal: number): string {
  const name =
    Object.entries(os.constants.signals).find(([, n]) => n === signal)?.[0] ?? `シグナル ${signal}`
  return `\r\n\x1b[2m[プロセスが ${name} で終了しました。Enter で閉じる]\x1b[0m\r\n`
}

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
  // attach のセンチネルまでにパースした出力は snapshot に含め、個別には送らない。
  snapshotPending: boolean
  terminalTail: Promise<void>
  queuedPtyBytes: number
  hookState: HookState | null
  hookStateAt: number
  lastOutputAt: number
  lastContentAt: number
  activityScreen: string
  pendingContent: {screen: string; at: number} | null
  activityExpired: boolean
  bellAt: number
  paused: boolean
  lastLoggedState: SessionState | null
  metrics: SessionMetrics | null
  attentionMessage: string | null
  activeAgent: AgentKind | null
  codex: CodexActivity | null
  codexRunId: string | null
}

export class SessionManager {
  private sessions = new Map<string, Session>()
  private counter = 0
  private cols = 80
  private rows = 24
  private attachEpoch = 0
  private lastResizeAt = 0
  private unackedBytes = 0
  private lastEmitted = ''
  private readonly tickTimer: NodeJS.Timeout
  private readonly cwdTimer: NodeJS.Timeout
  private disposed = false
  activeId: string | null = null

  onSessionsUpdate: (update: SessionsUpdate) => void = () => {}
  onTermOut: (payload: TermOut) => void = () => {}
  /** 状態が変化した瞬間に呼ばれる(通知・バッジ用) */
  onStateChange: (info: SessionInfo, prev: SessionState | null) => void = () => {}
  /** 完了を示す hook でのみ通知する(静穏化や中断は完了ではない)。 */
  onResponseComplete: (info: SessionInfo) => void = () => {}
  /** OSC 52 によるクリップボード書き込み要求(main 側で Electron の clipboard へ接続する) */
  onClipboardWrite: (text: string) => void = () => {}

  // idPrefix はウィンドウごとに変えることで、複数ウィンドウ間でも
  // セッション ID(= hooks 通知の宛先)が衝突しないようにする
  constructor(
    private hookPort: number,
    private idPrefix = 's',
  ) {
    this.tickTimer = setInterval(() => this.emitIfChanged(false), TICK_MS)
    this.tickTimer.unref()
    // シェルの現在ディレクトリを追跡してカードタイトルに反映する
    this.cwdTimer = setInterval(() => {
      for (const s of this.sessions.values()) {
        if (!s.exited) this.refreshCwd(s)
      }
    }, CWD_POLL_MS)
    this.cwdTimer.unref()
  }

  create(): SessionInfo {
    if (this.disposed) throw new Error('SessionManager is disposed')
    const index = ++this.counter
    const id = `${this.idPrefix}${index}`
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
    // 外側の Codex のフラグを持ち込まず、このシェルで起動した CLI にだけ設定する。
    delete env.CLAUDE_TERM_CODEX
    env.LANG = env.LANG || 'ja_JP.UTF-8'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'claude-term'
    env.CLAUDE_TERM_SESSION = id
    env.CLAUDE_TERM_PORT = String(this.hookPort)
    env.CLAUDE_TERM_EXECUTABLE = process.execPath
    env.CLAUDE_TERM_CODEX_RELAY = path.join(__dirname, 'codexHookRelay.js')
    configureShellIntegration(shell, env)

    // アクティブセッションと同じディレクトリで開く(無ければホーム)
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined
    let cwd = active && !active.exited ? active.cwd : os.homedir()
    if (!fs.existsSync(cwd)) cwd = os.homedir()
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd,
      env,
    })
    trackPtySpawn()
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
      cwd,
      pty,
      term,
      serialize,
      answerback: null,
      exited: false,
      snapshotPending: false,
      terminalTail: Promise.resolve(),
      queuedPtyBytes: 0,
      hookState: null,
      hookStateAt: 0,
      lastOutputAt: Date.now(),
      lastContentAt: 0,
      activityScreen: '',
      pendingContent: null,
      activityExpired: false,
      bellAt: 0,
      paused: false,
      lastLoggedState: null,
      metrics: null,
      attentionMessage: null,
      activeAgent: null,
      codex: null,
      codexRunId: null,
    }
    this.enableAnswerback(session)
    term.onTitleChange((title) => {
      if (session.exited || session.activeAgent !== 'codex' || !session.codex?.applyTerminalTitle(title)) return
      session.hookState = session.codex.state
      session.attentionMessage = session.codex.message
      session.hookStateAt = Date.now()
      this.emitIfChanged(true)
    })
    // PTY はカーソル点滅や同じ画面の再描画でも出力する。
    // Claude の Stop 取りこぼし対策は、パース後の表示内容が変わったときだけ延長する。
    term.onWriteParsed(() => {
      if (session.activeAgent !== 'claude' || session.hookState !== 'running' || session.activityExpired) return
      const screen = this.screenOf(session)
      const now = Date.now()
      if (now - this.lastResizeAt <= RESIZE_GRACE_MS) {
        session.activityScreen = screen
        session.pendingContent = null
      } else {
        // 消去と再描画が別バッチに分かれても、短時間で元の画面へ戻れば活動に数えない。
        session.pendingContent = screen === session.activityScreen
          ? null : {screen, at: session.pendingContent?.at ?? now}
      }
    })
    term.onBell(() => {
      if (this.activeId !== session.id) session.bellAt = Date.now()
    })
    // OSC 9 (iTerm 系の通知シーケンス) も要注目として拾う
    term.parser.registerOscHandler(9, (data) => {
      // OSC 9;4 は進捗バーの制御であり、ユーザーへの通知ではない。
      if (data.startsWith('4;')) return true
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
    // OSC 52 (クリップボード転送) — tmux copy-mode や ssh 先の nvim 等からの
    // コピーをローカルのクリップボードへ届ける。形式は "<対象>;<base64>"(例 "c;aGVsbG8=")
    term.parser.registerOscHandler(52, (data) => {
      const sep = data.indexOf(';')
      if (sep < 0) return true
      const payload = data.slice(sep + 1)
      // "?" はクリップボード読み出し要求 — 内容漏えいの恐れがあるため応じない
      if (!payload || payload === '?') return true
      // 非アクティブセッションには書き換えさせない(裏のプロセスによる改変防止)
      if (this.activeId !== session.id) return true
      const text = Buffer.from(payload, 'base64').toString('utf8')
      if (text) this.onClipboardWrite(text)
      return true
    })
    pty.onData((data) => this.handlePtyData(session, data))
    pty.onExit(({signal}) => {
      trackPtyExit()
      session.exited = true
      if (this.disposed || this.sessions.get(id) !== session) return
      this.disableAnswerback(session)
      // シェルが死んだ以上 claude も居ないので hook 由来の状態は捨てる(改行支援のゲートにも効く)
      session.hookState = null
      session.activeAgent = null
      session.codex = null
      session.codexRunId = null
      session.metrics = null
      session.attentionMessage = null
      // signal は macOS/Linux では常に数値(型が optional なのは Windows 向け)
      const sig = signal ?? 0
      if (sig === 0) {
        // シェル自身が終了した(exit / Ctrl+D)ので、通常のターミナルと同様にセッションごと閉じる。
        // 終了コードは判定に使わない: 対話シェルの `exit` は直前コマンドの終了ステータスを返すため、
        // 失敗したコマンドや Ctrl+C の直後に exit すると 1 や 130 になるが、異常終了ではない
        this.removeSession(session.id)
      } else {
        // シグナルで死んだ(クラッシュ・外部からの kill)場合は出力を確認できるよう
        // 「終了」カードとして残し、何が起きたかと閉じ方を画面末尾に示す(Enter で閉じる: inputToActive)
        this.handlePtyData(session, exitNotice(sig))
        this.emitIfChanged(true)
      }
    })

    this.sessions.set(id, session)
    this.emitIfChanged(true)
    return this.toInfo(session)
  }

  /**
   * セッションをメイン表示に切り替える。
   * xterm の write 完了を待つキューで、既存出力をパースしてから serialize する。
   * それ以前の出力は snapshot に含め、それ以降の出力はパース後に個別送信する。
   * resize も同じキューに並べ、snapshot の寸法と出力順を一致させる。
   */
  attach(id: string): void {
    const next = this.sessions.get(id)
    if (!next) return
    const prev = this.activeId ? this.sessions.get(this.activeId) : undefined
    if (prev && prev !== next) {
      this.enableAnswerback(prev)
      prev.snapshotPending = false
    }
    this.activeId = id
    next.bellAt = 0
    next.snapshotPending = true
    const epoch = ++this.attachEpoch
    this.unackedBytes = 0
    if (prev) this.updateFlowControl(prev)
    this.updateFlowControl(next)
    void this.queueTerminal(next, () => {
      if (this.attachEpoch !== epoch || this.activeId !== id) return
      this.disableAnswerback(next)
      const snapshot = next.serialize.serialize({scrollback: SNAPSHOT_SCROLLBACK})
      next.snapshotPending = false
      this.emitToRenderer(next, {kind: 'snapshot', id, epoch, data: snapshot, cols: next.term.cols, rows: next.term.rows})
    })
    this.emitIfChanged(true)
  }

  inputToActive(data: string): void {
    if (this.activeId) this.inputToSession({id: this.activeId, data})
  }

  /** パース中の旧画面への応答も、その画面を出力したセッションに戻す。 */
  inputToSession(input: TermInput): void {
    if (!input || typeof input.id !== 'string' || typeof input.data !== 'string') return
    const {id, data} = input
    const s = this.sessions.get(id)
    if (!s) return
    if (s.exited) {
      // 「終了」カードは Enter で閉じる(画面末尾の案内どおり)。他のキーは無視
      if (data === '\r') this.removeSession(s.id)
      return
    }
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
    this.removeSession(id)
  }

  private removeSession(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    // 削除前の表示順を控えておき、アクティブだった場合は近傍(次、無ければ手前)へ移る
    const order = [...this.sessions.values()]
    const pos = order.indexOf(s)
    this.disableAnswerback(s)
    s.term.dispose()
    this.sessions.delete(id)
    if (this.activeId === id) {
      this.activeId = null
      const next = order[pos + 1] ?? order[pos - 1]
      if (next) this.attach(next.id)
    }
    this.emitIfChanged(true)
  }

  /**
   * サイドバーのドラッグ&ドロップで確定した表示順を反映する。
   * 表示順の実体は Map の挿入順なので、指定順で作り直す。
   * 不明な ID は無視し、指定に含まれないセッション(並び替え中に増えた等)は末尾に残す。
   */
  reorder(ids: string[]): void {
    if (!Array.isArray(ids)) return
    const next = new Map<string, Session>()
    for (const id of ids) {
      const s = this.sessions.get(id)
      if (s) next.set(id, s)
    }
    for (const [id, s] of this.sessions) {
      if (!next.has(id)) next.set(id, s)
    }
    this.sessions = next
    this.emitIfChanged(true)
  }

  resize(cols: number, rows: number): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 2) return
    if (cols === this.cols && rows === this.rows) return
    this.cols = cols
    this.rows = rows
    this.lastResizeAt = Date.now()
    // 受信済みの出力を旧寸法でパースしてから、寸法変更を同じストリームへ送る。
    // PTY の SIGWINCH による新寸法の出力も、必ず resize 通知より後になる。
    for (const s of this.sessions.values()) {
      void this.queueTerminal(s, () => {
        let reflowCursorLine = true
        try {
          // macOS の node-pty は前景プロセスを取得する。シェルの行編集は自身の再描画へ任せる。
          // シェル自身で動くスクリプトも同名になるため、その場合は従来の resize を維持する。
          reflowCursorLine = !SHELL_PROCESSES.has(path.basename(s.pty.process).replace(/^-+/, ''))
        } catch {
          // 前景プロセスが取れない場合も、表示済みの内容とカーソル位置を保持する。
        }
        if (reflowCursorLine) resizeTerminal(s.term, cols, rows)
        else s.term.resize(cols, rows)
        this.lastResizeAt = Date.now()
        s.activityScreen = this.screenOf(s)
        s.pendingContent = null
        if (this.activeId === s.id && !s.snapshotPending) {
          this.emitToRenderer(s, {kind: 'resize', id: s.id, epoch: this.attachEpoch, cols, rows, reflowCursorLine})
        }
        if (!s.exited) {
          try {
            s.pty.resize(cols, rows)
          } catch {
            // race で死んでいたら無視
          }
        }
      })
    }
  }

  ack(ack: TermAck): void {
    if (!ack || ack.id !== this.activeId || ack.epoch !== this.attachEpoch ||
        !Number.isSafeInteger(ack.bytes) || ack.bytes < 0) return
    this.unackedBytes = Math.max(0, this.unackedBytes - ack.bytes)
    if (this.activeId) {
      const s = this.sessions.get(this.activeId)
      if (s) this.updateFlowControl(s)
    }
  }

  setHookState(id: string, state: string, rawBody = ''): void {
    const s = this.sessions.get(id)
    if (!s || s.exited || !['running', 'attention', 'idle', 'clear'].includes(state)) return
    // CLI の存在を追跡できる間は、遅れた Claude hook や子プロセスで提供元を上書きしない。
    if (s.codexRunId) return
    // Codex の後へ遅れて到着した Claude の終了イベントで表示を消さない。
    if (state === 'clear' && s.activeAgent !== 'claude') return
    const completed = state === 'idle' && (!rawBody || extractHookField(rawBody, 'hook_event_name') === 'Stop') &&
      s.activeAgent === 'claude' &&
      (s.hookState === 'running' || s.hookState === 'attention')
    if (state === 'clear') {
      s.hookState = null
      s.metrics = null // claude セッション終了とともにメトリクスも消す
      s.attentionMessage = null
      s.activeAgent = null
    } else {
      if (s.activeAgent !== 'claude') s.metrics = null
      s.activeAgent = 'claude'
      s.codex = null
      s.hookState = state as HookState
      s.attentionMessage = state === 'attention' ? extractHookField(rawBody, 'message') : null
      if (state === 'running') {
        s.activityScreen = this.screenOf(s)
        s.pendingContent = null
        s.activityExpired = false
      }
    }
    s.hookStateAt = Date.now()
    this.emitIfChanged(true)
    if (completed) this.onResponseComplete(this.toInfo(s))
  }

  /** CLI の存在だけを記録する。実際のスレッド・使用量・実行状態は hook で取得する。 */
  setCodexProcess(id: string, runId: string, event: 'start' | 'exit'): void {
    const s = this.sessions.get(id)
    if (!s || s.exited || !/^[A-Za-z0-9_-]{1,128}$/.test(runId)) return
    if (event === 'exit') {
      if (s.codexRunId !== runId) return
      s.codexRunId = null
      this.clearCodexSession(id)
      return
    }
    if (event !== 'start' || s.codexRunId === runId) return
    s.codexRunId = runId
    s.activeAgent = 'codex'
    s.codex = null
    s.hookState = null
    s.metrics = null
    s.attentionMessage = null
    s.bellAt = 0
    this.emitIfChanged(true)
  }

  setCodexHook(id: string, rawBody: string): void {
    const s = this.sessions.get(id)
    const e = parseCodexEvent(rawBody)
    if (!s || s.exited || !e) return
    if (e.event === 'SessionStart') {
      if (e.agentId || (e.source && !['startup', 'resume', 'clear'].includes(e.source))) return
      s.codex = new CodexActivity(e.sessionId)
      s.codex.model = e.model
    } else if (!s.codex) {
      // /hooks で途中から有効化した場合も、最初の処理イベントから検知できる。
      if (!['UserPromptSubmit', 'PreToolUse', 'PermissionRequest'].includes(e.event) || e.agentId) return
      s.codex = new CodexActivity(e.sessionId)
    }
    if (s.codex.sessionId !== e.sessionId || s.codex.ended) return
    const completed = s.codex.apply(e)
    if (s.codex.ended) {
      s.activeAgent = s.codexRunId ? 'codex' : null
      s.hookState = null
      s.attentionMessage = null
      s.metrics = null
      s.bellAt = 0
      s.lastOutputAt = 0
    } else {
      s.activeAgent = 'codex'
      s.hookState = s.codex.state
      s.attentionMessage = s.codex.message
      s.metrics = s.codex.model || s.codex.usage
        ? {...s.codex.usage, ...(s.codex.model ? {model: s.codex.model} : {})} : null
    }
    s.hookStateAt = Date.now()
    this.emitIfChanged(true)
    if (completed) this.onResponseComplete(this.toInfo(s))
  }

  clearCodexSession(id: string): void {
    const s = this.sessions.get(id)
    // ID のない旧 wrapper の終了通知は、新しい追跡中 CLI を解除できない。
    if (!s || s.exited || s.activeAgent !== 'codex' || s.codexRunId) return
    if (s.codex) s.codex.ended = true
    s.activeAgent = null
    s.hookState = null
    s.metrics = null
    s.attentionMessage = null
    s.bellAt = 0
    s.lastOutputAt = 0
    s.hookStateAt = Date.now()
    this.emitIfChanged(true)
  }

  /**
   * statusLine スクリプトから転送された Claude Code のセッション情報 JSON を取り込み、
   * claude の画面に表示するステータス行(整形済み文字列)を返す。
   */
  applyStatus(id: string, rawJson: string): string | null {
    const s = this.sessions.get(id)
    if (!s || s.exited || s.activeAgent === 'codex') return null
    let data: Record<string, any>
    try {
      data = JSON.parse(rawJson) as Record<string, any>
    } catch {
      return null
    }
    const model =
      typeof data?.model?.display_name === 'string' ? (data.model.display_name as string) : undefined
    const cw = data?.context_window
    let contextPct: number | undefined
    if (typeof cw?.remaining_percentage === 'number') contextPct = Math.round(cw.remaining_percentage)
    else if (typeof cw?.used_percentage === 'number') contextPct = Math.round(100 - cw.used_percentage)
    const cost = data?.cost?.total_cost_usd
    const costUsd = typeof cost === 'number' ? cost : undefined
    s.metrics = {model, contextPct, costUsd}
    this.emitIfChanged(true)
    const parts: string[] = []
    if (model) parts.push(model)
    if (contextPct !== undefined) parts.push(`コンテキスト残り${contextPct}%`)
    if (costUsd !== undefined) parts.push(`$${costUsd.toFixed(2)}`)
    return parts.join(' · ')
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

  /** 検証用: 呼出時点までの出力・リサイズ・attach の処理を待つ。 */
  whenTerminalReady(id: string): Promise<void> {
    return this.sessions.get(id)?.terminalTail ?? Promise.resolve()
  }

  disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.tickTimer)
    clearInterval(this.cwdTimer)
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
    this.unackedBytes = 0
    this.attachEpoch++
  }

  private handlePtyData(s: Session, data: string): void {
    if (this.disposed || this.sessions.get(s.id) !== s) return
    const now = Date.now()
    // リサイズ起因の再描画出力を「実行中」と誤認しない
    if (now - this.lastResizeAt > RESIZE_GRACE_MS) s.lastOutputAt = now
    s.queuedPtyBytes += data.length
    this.updateFlowControl(s)
    void this.queueTerminal(s, async () => {
      await new Promise<void>((resolve) => s.term.write(data, resolve))
      s.queuedPtyBytes -= data.length
      if (this.sessions.get(s.id) === s && this.activeId === s.id && !s.snapshotPending) {
        this.emitToRenderer(s, {kind: 'data', id: s.id, epoch: this.attachEpoch, data})
      }
      this.updateFlowControl(s)
    })
  }

  private queueTerminal(s: Session, operation: () => void | Promise<void>): Promise<void> {
    // xterm の write callback 内で resize/reset を再入させず、後続出力も追い越させない。
    s.terminalTail = s.terminalTail.then(() => {
      if (this.sessions.get(s.id) === s) return operation()
    })
    return s.terminalTail
  }

  private emitToRenderer(s: Session, payload: TermOut): void {
    if (payload.kind !== 'resize') this.unackedBytes += payload.data.length
    this.onTermOut(payload)
    this.updateFlowControl(s)
  }

  private updateFlowControl(s: Session): void {
    if (s.exited || this.disposed || this.sessions.get(s.id) !== s) return
    // 裏側でもパース待ちを制限し、表示中だけ renderer の未消化分を足す。
    const backlog = s.queuedPtyBytes + (this.activeId === s.id ? this.unackedBytes : 0)
    if (!s.paused && backlog > HIGH_WATER) {
      s.paused = true
      try {
        s.pty.pause()
        console.log(`[flow] pause ${s.id} unacked=${this.unackedBytes}`)
      } catch {
        s.paused = false
      }
    } else if (s.paused && backlog < LOW_WATER) {
      this.resumeIfPaused(s)
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
    if (s.activeAgent === 'codex' && s.hookState === null) return 'unknown'
    const now = Date.now()
    if (s.hookState === 'attention') return 'attention'
    if (s.hookState === 'idle') return 'idle'
    if (s.hookState === 'running') {
      // Codex は無出力の推論中も実行を継続する。Stop/Interrupt/SessionEnd を優先する。
      if (s.activeAgent === 'codex') return 'running'
      if (!s.activityExpired && s.pendingContent) {
        if (now - s.pendingContent.at < SCREEN_SETTLE_MS) return 'running'
        s.activityScreen = s.pendingContent.screen
        s.lastContentAt = s.pendingContent.at
        s.pendingContent = null
      }
      // 中断では Stop が発火しない。再描画を除く活動が途絶えたら待機へ戻す。
      if (!s.activityExpired && now - Math.max(s.hookStateAt, s.lastContentAt) < HOOK_RUNNING_STALE_MS) return 'running'
      // 一度待機と判定したら、下書きの文字エコー等では再開せず次の hook を待つ。
      s.activityExpired = true
      // hook があるセッションを生の PTY 出力で実行中に戻さない。
      return s.bellAt && this.activeId !== s.id ? 'attention' : 'idle'
    }
    if (s.bellAt && this.activeId !== s.id) return 'attention'
    if (now - s.lastOutputAt < ACTIVITY_WINDOW_MS) return 'running'
    return 'idle'
  }

  private screenOf(s: Session): string {
    const buf = s.term.buffer.active
    const lines: string[] = []
    for (let y = buf.baseY; y < buf.baseY + s.term.rows; y++) {
      lines.push(buf.getLine(y)?.translateToString(true) ?? '')
    }
    return lines.join('\n').trimEnd()
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
      metrics: s.metrics,
      attentionMessage: s.attentionMessage,
      activeAgent: s.activeAgent,
    }
  }

  private emitIfChanged(force: boolean): void {
    const update = this.currentUpdate()
    for (const info of update.sessions) {
      const s = this.sessions.get(info.id)
      if (s && s.lastLoggedState !== info.state) {
        console.log(`[state] ${info.id} ${s.lastLoggedState ?? 'new'} -> ${info.state}`)
        const prev = s.lastLoggedState
        s.lastLoggedState = info.state
        this.onStateChange(info, prev)
      }
    }
    const key = JSON.stringify(update)
    if (!force && key === this.lastEmitted) return
    this.lastEmitted = key
    this.onSessionsUpdate(update)
  }
}
