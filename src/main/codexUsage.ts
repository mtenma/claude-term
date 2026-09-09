import * as fs from 'node:fs'
import * as path from 'node:path'
import type {SessionMetrics} from '../shared/types'

export type CodexUsage = Pick<SessionMetrics, 'contextPct' | 'totalTokens' | 'rateLimits'>

const READ_LIMIT = 1024 * 1024
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const nonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** relay から届く値も検証し、未知の形式を数値の 0 として表示しない。 */
export function parseCodexUsage(value: unknown): CodexUsage | null {
  const data = record(value)
  const usage: CodexUsage = {}
  if (nonNegative(data.totalTokens) && Number.isSafeInteger(data.totalTokens)) usage.totalTokens = data.totalTokens
  if (nonNegative(data.contextPct) && data.contextPct <= 100) usage.contextPct = Math.round(data.contextPct)
  if (Array.isArray(data.rateLimits)) {
    usage.rateLimits = data.rateLimits.slice(0, 2).flatMap((item) => {
      const limit = record(item)
      return nonNegative(limit.remainingPct) && limit.remainingPct <= 100 &&
        nonNegative(limit.windowMinutes) && limit.windowMinutes > 0
        ? [{remainingPct: Math.round(limit.remainingPct), windowMinutes: limit.windowMinutes}] : []
    })
  }
  return Object.keys(usage).length ? usage : null
}

/**
 * hook が指す同一セッションの記録から使用量だけ取り出す。本文・パスは転送しない。
 * transcript は非安定形式なので、読めない場合や未知の形式では表示を省略する。
 * 先頭と末尾それぞれ最大 1 MiB に制限し、巨大な履歴で同期 hook を止めない。
 */
export function readCodexUsage(transcriptPath: unknown, sessionId: string): CodexUsage | null {
  if (typeof transcriptPath !== 'string' || !path.isAbsolute(transcriptPath) || !transcriptPath.endsWith('.jsonl')) return null
  let fd: number | undefined
  try {
    fd = fs.openSync(transcriptPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return null
    const read = (offset: number, length: number): string => {
      const buffer = Buffer.alloc(length)
      return buffer.subarray(0, fs.readSync(fd!, buffer, 0, length, offset)).toString('utf8')
    }
    const head = read(0, Math.min(stat.size, READ_LIMIT))
    const firstEnd = head.indexOf('\n')
    if (firstEnd < 0) return null
    const meta = record(JSON.parse(head.slice(0, firstEnd)))
    if (meta.type !== 'session_meta' || record(meta.payload).id !== sessionId) return null

    const offset = Math.max(0, stat.size - READ_LIMIT)
    const tail = offset ? read(offset, stat.size - offset) : head
    const lines = tail.split('\n')
    if (offset) lines.shift() // 読み始めが行の途中なら捨てる。
    lines.pop() // 書込み中の最終行は次の hook で読む。
    const usage: CodexUsage = {}
    let foundInfo = false
    let foundLimits = false
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"token_count"')) continue
      let event: Record<string, unknown>
      try {
        event = record(JSON.parse(lines[i]))
      } catch {
        continue
      }
      const payload = record(event.payload)
      if (event.type !== 'event_msg' || payload.type !== 'token_count') continue
      const info = record(payload.info)
      const total = record(info.total_token_usage).total_tokens
      const current = record(info.last_token_usage).total_tokens
      const window = info.model_context_window
      if (!foundInfo && nonNegative(total) && Number.isSafeInteger(total)) {
        usage.totalTokens = total
        if (nonNegative(current) && nonNegative(window) && window > 0) {
          usage.contextPct = Math.round(100 * Math.max(0, 1 - current / window))
        }
        foundInfo = true
      }
      if (!foundLimits && payload.rate_limits !== null && typeof payload.rate_limits === 'object') {
        const limits = record(payload.rate_limits)
        usage.rateLimits = [limits.primary, limits.secondary].flatMap((item) => {
          const limit = record(item)
          return nonNegative(limit.used_percent) && nonNegative(limit.window_minutes) && limit.window_minutes > 0
            ? [{remainingPct: Math.round(Math.max(0, 100 - limit.used_percent)), windowMinutes: limit.window_minutes}] : []
        })
        foundLimits = true
      }
      if (foundInfo && foundLimits) break
    }
    return parseCodexUsage(usage)
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
