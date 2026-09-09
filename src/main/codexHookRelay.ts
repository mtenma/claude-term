import * as http from 'node:http'
import {projectCodexEvent} from './codexEvents'
import {readCodexUsage} from './codexUsage'

// Electron 自身を Node として起動するので、配布アプリでも別途 Node/Python の導入が不要。
const port = Number(process.env.CLAUDE_TERM_PORT)
const session = process.env.CLAUDE_TERM_SESSION ?? ''
if (process.env.CLAUDE_TERM_CODEX === '1' && Number.isInteger(port) && port > 0 && port <= 65535 && /^[A-Za-z0-9_-]+$/.test(session)) {
  const chunks: Buffer[] = []
  let size = 0
  process.stdin.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size <= 16 * 1024 * 1024) chunks.push(chunk)
  })
  process.stdin.on('error', () => {})
  process.stdin.on('end', () => {
    if (size > 16 * 1024 * 1024) return
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const event = projectCodexEvent(input)
      if (!event) return
      if (!event.agentId) event.usage = readCodexUsage(input.transcript_path, event.sessionId)
      const body = JSON.stringify(event)
      const req = http.request({
        hostname: '127.0.0.1', port, path: `/codex/${session}`, method: 'POST',
        headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
      }, (res) => res.resume())
      req.on('error', () => {})
      req.setTimeout(700, () => req.destroy())
      req.end(body)
    } catch {
      // 状態通知の不調で Codex の処理や承認判断を止めない。stdout にも何も返さない。
    }
  })
}
