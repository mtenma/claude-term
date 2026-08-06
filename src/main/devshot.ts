import {app, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import {CH} from '../shared/types'
import {whenAllPtysExited, type SessionManager} from './sessions'

/**
 * 開発検証用の自動スクリーンショット。
 * CLAUDE_TERM_SCREENSHOT=<出力PNGパス> が設定されているときだけ動く。
 * CLAUDE_TERM_DEMO でシナリオを選択:
 *   empty  … セッション無し(プレースホルダ確認)
 *   basic  … 1セッションで色付き出力
 *   states … 4セッションで 実行中/承認待ち/待機/終了 の4状態を再現
 *   search … ⌘F 検索バーを開いて「error」を検索した状態(ハイライト確認)
 *   settings … 外観設定パネルを開いた状態
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
  } else if (scenario === 'search') {
    const a = sm.create()
    sm.attach(a.id)
    at(1500, () => {
      sm.writeTo(a.id, "printf 'error: one\\nok line\\nerror: two\\nplain\\nerror: three\\n'\r")
    })
    at(3500, () => {
      win.webContents.send(CH.editFind)
      // 検索入力欄へ合成キーイベントで「error」を打ち込む
      for (const ch of 'error') {
        win.webContents.sendInputEvent({type: 'char', keyCode: ch})
      }
    })
  } else if (scenario === 'settings') {
    const a = sm.create()
    sm.attach(a.id)
    at(1500, () => sm.writeTo(a.id, 'echo 外観設定デモ\r'))
    at(3000, () => win.webContents.send(CH.editOpenSettings))
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
        `sleep 1; curl -s -m 1 -X POST -H 'Content-Type: application/json' --data '{"message":"Claude needs your permission to use Bash"}' "http://127.0.0.1:$CLAUDE_TERM_PORT/state/$CLAUDE_TERM_SESSION/attention"; ` +
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
        // CLAUDE_TERM_PROBE=x,y;x,y … 指定座標(CSS px)の実ピクセルと、
        // 透過に関わる DOM の計算済みスタイルを出力する(透過検証用)
        if (process.env.CLAUDE_TERM_PROBE) {
          const bmp = img.toBitmap() // BGRA
          const size = img.getSize()
          const [w] = win.getContentSize()
          const scale = size.width / w
          for (const pt of process.env.CLAUDE_TERM_PROBE.split(';')) {
            const [x, y] = pt.split(',').map((n) => Math.round(Number(n) * scale))
            const i = (y * size.width + x) * 4
            console.log(
              `[probe] css(${pt}) BGRA=${bmp[i]},${bmp[i + 1]},${bmp[i + 2]},${bmp[i + 3]}`,
            )
          }
          const dom = (await win.webContents.executeJavaScript(`(() => {
            const cs = (sel) => {
              const n = document.querySelector(sel)
              return n ? getComputedStyle(n).backgroundColor : null
            }
            return JSON.stringify({
              body: cs('body'),
              viewport: cs('.xterm-viewport'),
              screen: cs('.xterm-screen'),
              canvases: document.querySelectorAll('#term-host canvas').length,
            })
          })()`)) as string
          console.log(`[probe-dom] ${dom}`)
        }
      } catch (err) {
        console.error('[devshot] failed:', err)
        code = 1
      }
      // app.exit は will-quit を通らないため、ここでも PTY の onExit 配送を待ってから終了する
      sm.disposeAll()
      await whenAllPtysExited(1500)
      setTimeout(() => app.exit(code), 50)
    })()
  })
}
