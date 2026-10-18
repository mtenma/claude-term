import type {AgentKind} from '../shared/types'

/** 1 回分の API 呼出し。本文は持たない */
export interface UsageRow {
  /** 重複除去のキー。同じ呼出しが複数の行・ファイルに書かれても 1 行にまとまる */
  key: string
  agent: AgentKind
  sessionId: string
  ts: number
  model: string
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  webSearch: number
  speed: string
  geo: string
  /** 1 回の入力の合計(キャッシュ分を含む)。長文脈の単価の判定に使う */
  prompt: number
}

/** セッションを始めたフォルダの候補。最も早い時刻のものを採用する */
export interface SessionStart {
  agent: AgentKind
  sessionId: string
  ts: number
  cwd: string
}

export interface ParsedLines {
  rows: UsageRow[]
  starts: SessionStart[]
  /** JSON として読めなかった行の数。例外の文面には本文の断片が入るため件数だけ数える */
  parseErrors: number
}

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const time = (value: unknown): number => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) ? ms : 0
}

function parse(line: string, out: ParsedLines): Json | null {
  try {
    return record(JSON.parse(line))
  } catch {
    out.parseErrors++
    return null
  }
}

/**
 * Claude Code の記録(~/.claude/projects 配下)の 1 行。応答 1 件が content ブロックごとに
 * 複数行へ書かれ、途中の行は output_tokens が小さいため、取込み時に大きいほうを残す
 */
export function parseClaudeLine(line: string, out: ParsedLines): void {
  if (!line.includes('"usage"')) return
  const data = parse(line, out)
  if (!data || data.type !== 'assistant') return
  const message = record(data.message)
  const usage = record(message.usage)
  const model = text(message.model)
  const id = text(message.id)
  const requestId = text(data.requestId)
  const sessionId = text(data.sessionId)
  const ts = time(data.timestamp)
  if (!id || !requestId || !model || model === '<synthetic>' || !ts || Object.keys(usage).length === 0) return
  const creation = record(usage.cache_creation)
  const hasBreakdown = 'ephemeral_5m_input_tokens' in creation || 'ephemeral_1h_input_tokens' in creation
  const input = count(usage.input_tokens)
  const cacheWrite5m = hasBreakdown ? count(creation.ephemeral_5m_input_tokens) : count(usage.cache_creation_input_tokens)
  const cacheWrite1h = hasBreakdown ? count(creation.ephemeral_1h_input_tokens) : 0
  const cacheRead = count(usage.cache_read_input_tokens)
  out.rows.push({
    key: `c:${id}:${requestId}`,
    agent: 'claude',
    sessionId,
    ts,
    model,
    input,
    cacheWrite5m,
    cacheWrite1h,
    cacheRead,
    output: count(usage.output_tokens),
    webSearch: count(record(usage.server_tool_use).web_search_requests),
    speed: text(usage.speed),
    geo: text(usage.inference_geo),
    prompt: input + cacheWrite5m + cacheWrite1h + cacheRead,
  })
  const cwd = text(data.cwd)
  if (sessionId && cwd) out.starts.push({agent: 'claude', sessionId, ts, cwd})
}

const USAGE_FIELDS = [
  'input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens',
] as const

interface PendingRecord {
  responseId: string
  usage: number[]
  ts: number
  model: string
  sessionId: string
}

/** ファイルの途中から読み直すときに引き継ぐ状態(DB に JSON で保存する) */
export interface CodexState {
  sessionId: string
  model: string
  /** 直前の累計(USAGE_FIELDS の順) */
  total: number[] | null
  /** 1 回分の記録のうち、対応する累計の変化がまだ来ていないもの */
  pending: PendingRecord | null
}

export const emptyCodexState = (): CodexState => ({sessionId: '', model: '', total: null, pending: null})

const usageNumbers = (value: unknown): number[] => {
  const usage = record(value)
  return USAGE_FIELDS.map((field) => count(usage[field]))
}

function codexRow(key: string, numbers: number[], ts: number, model: string, sessionId: string): UsageRow {
  const [input, cached, cacheWrite, output] = numbers
  return {
    key,
    agent: 'codex',
    sessionId,
    ts,
    model,
    // input_tokens はキャッシュ読込・書込を含む
    input: Math.max(0, input - cached - cacheWrite),
    cacheWrite5m: cacheWrite,
    cacheWrite1h: 0,
    cacheRead: cached,
    output,
    webSearch: 0,
    speed: '',
    geo: '',
    prompt: input,
  }
}

const sameNumbers = (a: number[] | null, b: number[]): boolean =>
  a !== null && a.length === b.length && a.every((value, index) => value === b[index])

/**
 * Codex の記録(rollout-*.jsonl)を 1 ファイル分、状態を持って読む。
 * - 基本は token_count の「累計が変わった回の last_token_usage」を数える。fork したファイルには
 *   親の token_count の写しが時刻を書き換えて入るため、キーは累計と 1 回分の数値だけで作る
 * - 新しい記録の token_usage_record は対応する token_count より先に書かれる。累計が変わらない
 *   (文脈圧縮など)か、次の record が来たときだけ、record 側を 1 回分として数える
 */
export class CodexFileParser {
  readonly out: ParsedLines = {rows: [], starts: [], parseErrors: 0}

  constructor(public state: CodexState = emptyCodexState()) {}

  line(line: string): void {
    const head = line.slice(0, 200)
    if (head.includes('"session_meta"')) this.sessionMeta(line)
    else if (head.includes('"turn_context"')) this.turnContext(line)
    else if (head.includes('"token_usage_record"')) this.usageRecord(line)
    else if (line.includes('"token_count"')) this.tokenCount(line)
  }

  /** 対応する累計の変化が長く来ない record を数える(セッションが record で終わった場合) */
  flushPending(): void {
    if (this.state.pending) this.countPending()
  }

  private countPending(): void {
    const pending = this.state.pending!
    this.out.rows.push(codexRow(`x:r:${pending.responseId}`, pending.usage, pending.ts, pending.model, pending.sessionId))
    this.state.pending = null
  }

  private sessionMeta(line: string): void {
    const data = parse(line, this.out)
    if (!data || data.type !== 'session_meta') return
    // fork したファイルは 2 つ目に親の session_meta を持つ。1 つ目(自分)だけを使う
    if (this.state.sessionId) return
    const payload = record(data.payload)
    const sessionId = text(payload.id)
    if (!sessionId) return
    this.state.sessionId = sessionId
    const cwd = text(payload.cwd)
    const ts = time(data.timestamp) || time(payload.timestamp)
    if (cwd && ts) this.out.starts.push({agent: 'codex', sessionId, ts, cwd})
  }

  private turnContext(line: string): void {
    const data = parse(line, this.out)
    if (!data || data.type !== 'turn_context') return
    const model = text(record(data.payload).model)
    if (model) this.state.model = model
  }

  private usageRecord(line: string): void {
    const data = parse(line, this.out)
    if (!data || data.type !== 'token_usage_record') return
    const payload = record(data.payload)
    const responseId = text(payload.response_id)
    const ts = time(data.timestamp)
    if (!responseId || !ts) return
    if (this.state.pending) this.countPending()
    this.state.pending = {
      responseId,
      usage: usageNumbers(payload.usage),
      ts,
      model: this.state.model,
      sessionId: this.state.sessionId,
    }
  }

  private tokenCount(line: string): void {
    const data = parse(line, this.out)
    if (!data || data.type !== 'event_msg') return
    const payload = record(data.payload)
    if (payload.type !== 'token_count') return
    const info = record(payload.info)
    if (Object.keys(info).length === 0) return
    const total = usageNumbers(info.total_token_usage)
    const last = usageNumbers(info.last_token_usage)
    const changed = !sameNumbers(this.state.total, total)
    this.state.total = total
    const pending = this.state.pending
    if (!changed) {
      // 累計が変わらない回: 直前の record は token_count に表れない呼出し
      if (pending) this.countPending()
      return
    }
    if (pending && !sameNumbers(pending.usage.slice(0, 5), last.slice(0, 5))) this.countPending()
    this.state.pending = null
    const ts = time(data.timestamp)
    if (!ts) return
    this.out.rows.push(codexRow(`x:t:${[...total, ...last].join(',')}`, last, ts, this.state.model, this.state.sessionId))
  }
}
