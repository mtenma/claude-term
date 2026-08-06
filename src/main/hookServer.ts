import * as http from 'node:http'

const ROUTE = /^\/state\/([A-Za-z0-9_-]+)\/(running|attention|idle|clear)$/

/**
 * Claude Code の hooks から状態通知を受ける 127.0.0.1 限定の HTTP サーバ。
 * ポートは動的割当てで、各セッションの PTY 環境変数 CLAUDE_TERM_PORT として渡す。
 */
export function startHookServer(
  onState: (sessionId: string, state: string) => void,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const m = req.method === 'POST' ? req.url?.match(ROUTE) : null
      if (m) onState(m[1], m[2])
      res.statusCode = m ? 200 : 404
      res.end()
    })
    server.on('error', reject)
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0)
    })
  })
}
