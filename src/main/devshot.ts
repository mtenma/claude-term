import {app, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import type {SessionManager} from './sessions'

/**
 * 開発検証用の自動スクリーンショット。
 * CLAUDE_TERM_SCREENSHOT=<出力PNGパス> が設定されているときだけ動く。
 * CLAUDE_TERM_DEMO でシナリオを選択:
 *   empty  … セッション無し(プレースホルダ確認)
 *   basic  … 1セッションで色付き出力
 *   states … 4セッションで 実行中/承認待ち/待機/終了 の4状態を再現
 * 撮影後、成功なら exit 0 / 失敗なら exit 1 で終了する。
 */
export function maybeRunDevshot(win: BrowserWindow, sm: SessionManager): void {
  const out = process.env.CLAUDE_TERM_SCREENSHOT
  if (!out) return
  const scenario = process.env.CLAUDE_TERM_DEMO ?? 'empty'
  const captureDelay = Number(process.env.CLAUDE_TERM_SHOT_DELAY ?? 7000)

  win.setSize(1440, 900)

  const at = (ms: number, fn: () => void) => setTimeout(fn, ms)

  if (scenario === 'basic') {
    const a = sm.create()
    sm.attach(a.id)
    at(1500, () => {
      sm.writeTo(a.id, "printf '\\e[32mClaude Term\\e[0m デモ — 日本語表示テスト\\n'; ls -G\r")
    })
  } else if (scenario === 'flood') {
    // フロー制御の検証: 数MB の連続出力でも renderer が生きて撮影まで到達できること
    const a = sm.create()
    sm.attach(a.id)
    at(1500, () => {
      sm.writeTo(a.id, 'head -c 3000000 /dev/urandom | base64; echo FLOOD_DONE\r')
    })
  } else if (scenario === 'states') {
    const a = sm.create() // 実行中(緑): 連続出力
    const b = sm.create() // 承認待ち(オレンジ): hook サーバへ attention を通知
    const c = sm.create() // 待機(グレー): 出力後に静止
    const d = sm.create() // 終了(暗色)
    sm.attach(a.id)
    at(1500, () => {
      sm.writeTo(a.id, 'while true; do date; sleep 0.4; done\r')
      sm.writeTo(
        b.id,
        'sleep 1; curl -s -m 1 -X POST "http://127.0.0.1:$CLAUDE_TERM_PORT/state/$CLAUDE_TERM_SESSION/attention"; ' +
          `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data '{"model":{"display_name":"Opus 4.6"},"context_window":{"remaining_percentage":41.5},"cost":{"total_cost_usd":1.2345}}' "http://127.0.0.1:$CLAUDE_TERM_PORT/status/$CLAUDE_TERM_SESSION" > /dev/null\r`,
      )
      sm.writeTo(c.id, 'cd /private/tmp; echo 静止セッション\r')
      sm.writeTo(d.id, 'exit 1\r') // 異常終了(正常 exit はカードが自動で閉じるため)
    })
  }

  at(captureDelay, () => {
    void (async () => {
      let code = 0
      try {
        const img = await win.webContents.capturePage()
        const buf = img.toPNG()
        if (buf.length < 10_000) throw new Error(`screenshot too small (${buf.length} bytes)`)
        fs.writeFileSync(out, buf)
        console.log(`[devshot] wrote ${out} (${buf.length} bytes)`)
      } catch (err) {
        console.error('[devshot] failed:', err)
        code = 1
      }
      sm.disposeAll()
      app.exit(code)
    })()
  })
}
