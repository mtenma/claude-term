import * as http from 'node:http'

const STATE_RE = /^\/state\/([A-Za-z0-9_-]+)\/(running|attention|idle|clear)$/
const STATUS_RE = /^\/status\/([A-Za-z0-9_-]+)$/
const MAX_BODY = 64 * 1024

export interface HookServerHandlers {
  /** hooks からの状態遷移通知(rawBody は hook の stdin JSON、無ければ空文字) */
  onState: (sessionId: string, state: string, rawBody: string) => void
  /** statusLine スクリプトからの JSON 転送。表示用の1行を返す(なければ null) */
  onStatus: (sessionId: string, rawJson: string) => string | null
}

/**
 * Claude Code の hooks / statusLine から通知を受ける 127.0.0.1 限定の HTTP サーバ。
 * ポートは動的割当てで、各セッションの PTY 環境変数 CLAUDE_TERM_PORT として渡す。
 */
export function startHookServer(handlers: HookServerHandlers): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.statusCode = 404
        res.end()
        return
      }
      const stateMatch = req.url?.match(STATE_RE)
      const statusMatch = req.url?.match(STATUS_RE)
      if (!stateMatch && !statusMatch) {
        res.statusCode = 404
        res.end()
        return
      }
      let body = ''
      let overflow = false
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
        if (body.length > MAX_BODY) {
          overflow = true
          req.destroy()
        }
      })
      req.on('end', () => {
        if (overflow) return
        res.statusCode = 200
        if (stateMatch) {
          handlers.onState(stateMatch[1], stateMatch[2], body)
          res.end()
        } else if (statusMatch) {
          const line = handlers.onStatus(statusMatch[1], body)
          res.setHeader('Content-Type', 'text/plain; charset=utf-8')
          res.end(line ?? '')
        }
      })
    })
    server.on('error', reject)
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
}
