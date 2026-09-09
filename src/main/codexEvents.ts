import {createHash} from 'node:crypto'
import {CODEX_HOOK_EVENTS} from './codexHooksSettings'
import {parseCodexUsage, type CodexUsage} from './codexUsage'

export interface CodexEvent {
  event: string
  sessionId: string
  turnId: string | null
  agentId: string | null
  model: string | null
  source: string | null
  toolKey: string | null
  message: string | null
  usage: CodexUsage | null
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function text(value: unknown, limit = 200): string | null {
  return typeof value === 'string' && value.trim()
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : null
}

/** プロンプトやツール出力を転送せず、カード表示とイベントの対応付けに必要な情報だけ残す。 */
export function projectCodexEvent(input: unknown): CodexEvent | null {
  const data = record(input)
  const event = text(data.hook_event_name)
  const sessionId = text(data.session_id)
  if (!event || !(CODEX_HOOK_EVENTS as readonly string[]).includes(event) || !sessionId) return null
  const tool = record(data.tool_input)
  // 承認理由は PermissionRequest にだけ付くため、対応する PostToolUse の照合から除く。
  const args = typeof tool.command === 'string' ? tool.command :
    Object.fromEntries(Object.entries(tool).filter(([k]) => k !== 'description' && k !== 'justification').sort(([a], [b]) => a.localeCompare(b)))
  const toolName = text(data.tool_name)
  return {
    event,
    sessionId,
    turnId: text(data.turn_id),
    agentId: text(data.agent_id),
    model: text(data.model, 100),
    source: text(data.source),
    usage: null,
    toolKey: toolName ? createHash('sha256').update(JSON.stringify([data.agent_id ?? null, data.turn_id ?? null, toolName, args])).digest('hex') : null,
    message: event === 'PermissionRequest'
      ? text(tool.description) ?? text(tool.justification) ?? text(tool.command) ?? toolName ?? 'Codex が承認を待っています'
      : null,
  }
}

/** HTTP の入力も検証する。表示文字列にターミナル制御文字を持ち込まない。 */
export function parseCodexEvent(raw: string): CodexEvent | null {
  try {
    const data = record(JSON.parse(raw))
    const event = text(data.event)
    const sessionId = text(data.sessionId)
    if (!event || !(CODEX_HOOK_EVENTS as readonly string[]).includes(event) || !sessionId) return null
    return {
      event, sessionId,
      turnId: text(data.turnId), agentId: text(data.agentId), model: text(data.model, 100),
      source: text(data.source), toolKey: text(data.toolKey), message: text(data.message),
      usage: parseCodexUsage(data.usage),
    }
  } catch {
    return null
  }
}

interface CodexApproval {
  message: string
  resolved: boolean
}

export class CodexActivity {
  state: 'running' | 'attention' | 'idle' = 'idle'
  model: string | null = null
  usage: CodexUsage | null = null
  ended = false
  private turnId: string | null = null
  private running = false
  private finishedTurns = new Set<string>()
  private approvals = new Map<string, CodexApproval[]>()
  private attentionTitle: {project: string; approvals: CodexApproval[]} | null = null

  constructor(readonly sessionId: string) {}

  get message(): string | null {
    for (const approvals of this.approvals.values()) {
      const pending = approvals.find((approval) => !approval.resolved)
      if (pending) return pending.message
    }
    return this.attentionTitle ? 'Codex が承認または入力を待っています' : null
  }

  /** Codex 0.153.4 の既定タイトルで、承認画面から実行への復帰だけを補足する。 */
  applyTerminalTitle(title: string): boolean {
    if (this.ended || !this.running || !this.approvals.size) return false
    const previousState = this.state
    const previousMessage = this.message
    const attention = /^\[ [!.] \] Action Required \| (.+)$/.exec(title)
    if (attention) {
      this.attentionTitle = {project: attention[1], approvals: [...this.approvals.values()].flat()}
      this.state = 'attention'
    } else {
      const running = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (.+)$/.exec(title)
      if (!running || running[1] !== this.attentionTitle?.project) return false
      // 完了まで記録を残し、同じコマンドの次の承認を古い PostToolUse で消さない。
      // 承認画面を観測した後に届いた新しい要求も、この再開通知では解除しない。
      for (const approval of this.attentionTitle.approvals) approval.resolved = true
      this.attentionTitle = null
      this.state = this.message ? 'attention' : 'running'
    }
    return this.state !== previousState || this.message !== previousMessage
  }

  /** 完了通知は Stop の一度だけ。Interrupt・無出力・子エージェントの終了では通知しない。 */
  apply(e: CodexEvent): boolean {
    if (e.sessionId !== this.sessionId || this.ended) return false
    if (e.event === 'SessionEnd') {
      this.ended = true
      this.clearApprovals()
      return false
    }
    if (e.event === 'SessionStart') {
      this.usage = e.usage
      return false
    }
    if (e.turnId && this.finishedTurns.has(e.turnId)) return false
    if (e.agentId && !this.running) return false
    if (e.agentId && e.event !== 'PermissionRequest' && e.event !== 'PostToolUse') return false
    if (!e.agentId && this.turnId && e.turnId && this.turnId !== e.turnId && e.event !== 'UserPromptSubmit') return false
    if (!e.agentId && e.usage) this.usage = {...this.usage, ...e.usage}
    if (!e.agentId && e.model) this.model = e.model
    if (e.event === 'UserPromptSubmit') {
      if (this.turnId && this.turnId !== e.turnId) this.finishTurn(this.turnId)
      this.turnId = e.turnId
      this.running = true
      this.clearApprovals()
      this.state = 'running'
    } else if (e.event === 'PermissionRequest') {
      if (!e.agentId) {
        this.running = true
        this.turnId ??= e.turnId
      }
      const key = e.toolKey ?? 'approval'
      const messages = this.approvals.get(key) ?? []
      messages.push({message: e.message ?? 'Codex が承認を待っています', resolved: false})
      this.approvals.set(key, messages)
      this.state = 'attention'
    } else if (e.event === 'PreToolUse' || e.event === 'PostToolUse') {
      if (e.event === 'PostToolUse' && e.toolKey) {
        const messages = this.approvals.get(e.toolKey)
        messages?.shift()
        if (!messages?.length) this.approvals.delete(e.toolKey)
        if (!this.approvals.size) this.attentionTitle = null
      }
      if (!e.agentId) {
        this.running = true
        this.turnId ??= e.turnId
      }
      this.state = this.message ? 'attention' : this.running ? 'running' : 'idle'
    } else if ((e.event === 'Stop' || e.event === 'Interrupt') && !e.agentId) {
      if (this.turnId && e.turnId && this.turnId !== e.turnId) return false
      const completed = e.event === 'Stop' && this.state !== 'idle'
      this.running = false
      this.state = 'idle'
      this.clearApprovals()
      // 終了イベントに ID が無くても、把握済みのターンの遅延通知を遮断する。
      const finishedTurnId = e.turnId ?? this.turnId
      if (finishedTurnId) {
        this.finishTurn(finishedTurnId)
      }
      return completed
    }
    return false
  }

  private clearApprovals(): void {
    this.approvals.clear()
    this.attentionTitle = null
  }

  private finishTurn(id: string): void {
    this.finishedTurns.add(id)
    if (this.finishedTurns.size > 32) this.finishedTurns.delete(this.finishedTurns.values().next().value!)
  }
}
