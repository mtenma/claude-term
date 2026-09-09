import * as http from 'node:http'

const STATE_RE = /^\/state\/([A-Za-z0-9_-]+)\/(running|attention|idle|clear)$/
const STATUS_RE = /^\/status\/([A-Za-z0-9_-]+)$/
const CODEX_RE = /^\/codex\/([A-Za-z0-9_-]+)$/
const CODEX_EXIT_RE = /^\/codex-exit\/([A-Za-z0-9_-]+)$/
const CODEX_PROCESS_RE = /^\/codex-process\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]{1,128})\/(start|exit)$/
const MAX_BODY = 64 * 1024

export interface HookServerHandlers {
  /** hooks からの状態遷移通知(rawBody は hook の stdin JSON、無ければ空文字) */
  onState: (sessionId: string, state: string, rawBody: string) => void
  /** statusLine スクリプトからの JSON 転送。表示用の1行を返す(なければ null) */
  onStatus: (sessionId: string, rawJson: string) => string | null
  onCodex: (sessionId: string, rawJson: string) => void
  onCodexExit: (sessionId: string) => void
  /** シェル wrapper による CLI の存在通知。hook の実行状態とは分ける。 */
  onCodexProcess: (sessionId: string, runId: string, event: 'start' | 'exit') => void
}

/**
 * Claude Code / Codex の hooks と statusLine から通知を受けるローカルHTTPサーバ。
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
      const codexMatch = req.url?.match(CODEX_RE)
      const codexExitMatch = req.url?.match(CODEX_EXIT_RE)
      const codexProcessMatch = req.url?.match(CODEX_PROCESS_RE)
      if (!stateMatch && !statusMatch && !codexMatch && !codexExitMatch && !codexProcessMatch) {
        res.statusCode = 404
        res.end()
        return
      }
      let body = ''
      let bytes = 0
      let overflow = false
      req.setEncoding('utf8')
      req.on('error', () => {})
      req.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        body += chunk
        if (bytes > MAX_BODY) {
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
        } else if (codexProcessMatch) {
          handlers.onCodexProcess(codexProcessMatch[1], codexProcessMatch[2], codexProcessMatch[3] as 'start' | 'exit')
          res.end()
        } else if (codexExitMatch) {
          handlers.onCodexExit(codexExitMatch[1])
          res.end()
        } else if (codexMatch) {
          handlers.onCodex(codexMatch[1], body)
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
