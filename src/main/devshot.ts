import {app, type BrowserWindow} from 'electron'
import {checkRightEdge} from './devshotEdge'
import * as fs from 'node:fs'
import {CH} from '../shared/types'
import {whenAllPtysExited, type SessionManager} from './sessions'
import {checkResizeWrapping} from './devshotResize'

/**
 * 開発検証用の自動スクリーンショット。
 * CLAUDE_TERM_SCREENSHOT=<出力PNGパス> が設定されているときだけ動く。
 * CLAUDE_TERM_DEMO でシナリオを選択:
 *   empty  … セッション無し(プレースホルダ確認)
 *   basic  … 1セッションで色付き出力
 *   states … 4セッションで 実行中/承認待ち/待機/終了 の4状態を再現
 *   codex  … Codex/Claude/通常シェルの混在、カード表示・切替・入力・リサイズを検証
 *   search … ⌘F 検索バーを開いて「error」を検索した状態(ハイライト確認)
 *   settings … 外観設定パネルを開いた状態
 *   focus-switch … focus reporting 中のTUIから待機シェルへの切替回帰テスト
 *   ruler  … 全カラムに桁ルーラーを表示(右端の欠け・幅計算・描画ドリフトの検証)
 *   swap   … 透過設定の切替(WebGL↔DOM レンダラー)後の列数再計算の検証
 *   resize … ウィンドウリサイズ後の列数再計算とリフローの検証
 *   resize-wrap … 日本語の未確定行・続きの出力・長いシェル入力を幅変更とともに検証
 *   right-edge  … 日本語の句読点・各書体の描画幅をリサイズとズームで検証
 * CLAUDE_TERM_WINSIZE=<幅>x<高さ> で撮影ウィンドウの大きさを指定できる。
 * 撮影後、成功なら exit 0 / 失敗なら exit 1 で終了する。
 */
export function maybeRunDevshot(win: BrowserWindow, sm: SessionManager): void {
  const out = process.env.CLAUDE_TERM_SCREENSHOT
  if (!out) return
  const scenario = process.env.CLAUDE_TERM_DEMO ?? 'empty'
  const captureDelay = Number(process.env.CLAUDE_TERM_SHOT_DELAY ?? 7000)
  let scenarioFailure: Error | null = null
  let scenarioTask: Promise<void> | null = null

  // CLAUDE_TERM_WINSIZE=<幅>x<高さ> で撮影ウィンドウの大きさを変えられる
  // (右端欠けはホスト幅の端数に依存するため、報告と同じ幅で再現するのに使う)
  const winsize = /^(\d+)x(\d+)$/.exec(process.env.CLAUDE_TERM_WINSIZE ?? '')
  if (winsize) win.setSize(Number(winsize[1]), Number(winsize[2]))
  else win.setSize(1440, 900)

  const at = (ms: number, fn: () => void) => setTimeout(fn, ms)

  // 現在の cols を PTY 側から測って全カラムを埋めるルーラー。
  // 1行目: ASCII 桁ルーラー(cols 桁ちょうど)、2行目: 全角ルーラー(cols/2 文字)。
  // どちらも折り返し・右端欠けが無ければ PTY と描画の幅計算は一致している
  // 3行目: 半角と全角の混在ルーラー(あ1 = 3セル)。混在行は文字送りの丸め誤差が
  // 蓄積しやすく、純 ASCII・純全角の行では見えない右端の欠けを検出できる
  const rulerCmd =
    `cols=$(tput cols); echo "COLS=$cols"; ` +
    `awk -v n="$cols" 'BEGIN{s="";for(i=1;i<=n;i++)s=s substr("1234567890",(i-1)%10+1,1);print s}'; ` +
    `awk -v n="$cols" 'BEGIN{s="";for(i=1;i<=int(n/2)-1;i++)s=s"あ";print s"字"}'; ` +
    `awk -v n="$cols" 'BEGIN{s="";w=0;i=0;while(w+3<=n-1){s=s"あ" i%10;w+=3;i++}while(w<n-1){s=s".";w++}print s"E"}'\r`

  if (scenario === 'right-edge') {
    scenarioTask = checkRightEdge(win, sm).catch((error) => {
      scenarioFailure = error instanceof Error ? error : new Error(String(error))
    })
  } else if (scenario === 'resize-wrap') {
    scenarioTask = checkResizeWrapping(win, sm).catch((error) => {
      scenarioFailure = error instanceof Error ? error : new Error(String(error))
    })
  } else if (scenario === 'basic') {
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
      void win.webContents.executeJavaScript(`(() => {
        const counts = window.__flood = {received: 0, parsed: 0, writes: 0}
        window.claudeTerm.onTermOut(p => { if (p.kind !== 'resize') counts.received += p.data.length })
        const write = window.__term.write.bind(window.__term)
        window.__term.write = (data, callback) => write(data, () => {
          counts.parsed += data.length
          counts.writes++
          callback?.()
        })
      })()`).then(() => {
        sm.writeTo(a.id, 'head -c 3000000 /dev/urandom | base64; echo FLOOD_DONE\r')
      }).catch((error) => { scenarioFailure = error })
    })
    scenarioTask = (async () => {
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
        const done = await win.webContents.executeJavaScript(`(() => {
          const b = window.__term.buffer.active
          for (let i = 0; i < b.length; i++) {
            if (b.getLine(i)?.translateToString(true) === 'FLOOD_DONE') return true
          }
          return false
        })()`)
        if (done) {
          console.log('[flood] 4 MB output parsed and displayed through flow control PASS')
          return
        }
      }
      const progress = await win.webContents.executeJavaScript('window.__flood')
      throw new Error(`Flood output did not reach the renderer within 20 seconds: ${JSON.stringify(progress)}`)
    })().catch((error) => {
      scenarioFailure = error instanceof Error ? error : new Error(String(error))
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
  } else if (scenario === 'codex') {
    const a = sm.create()
    const b = sm.create()
    const c = sm.create()
    const d = sm.create()
    const e = sm.create() // hooks 未取得でも Codex の起動は検知する
    sm.attach(a.id)
    const hook = (id: string, event: string, extra: Record<string, unknown> = {}) => {
      sm.setCodexHook(id, JSON.stringify({event, sessionId: `test-${id}`, turnId: 'turn-1', model: 'test-model', ...extra}))
    }
    const approvalMessage = 'npm run check の実行を許可してください'
    const claudeStatus = JSON.stringify({
      model: {display_name: 'Opus 4.6'},
      context_window: {remaining_percentage: 41.5},
      cost: {total_cost_usd: 1.2345},
    })
    type CardUi = {
      id: string
      title: string | null
      agent: string | null
      model: string | null
      state: string | null
      stateTitle: string | null
      preview: string | null
      metrics: string[]
      height: number
      overflow: number
      agentWidth: number
      modelWidth: number
      attentionRows: number
    }
    const cardsScript = `[...document.querySelectorAll('.card')].map(card => ({
      id: card.dataset.id,
      title: card.querySelector('.card-title')?.textContent ?? null,
      agent: card.querySelector('.card-agent')?.textContent ?? null,
      model: card.querySelector('.card-model')?.textContent ?? null,
      state: card.querySelector('.card-state')?.textContent ?? null,
      stateTitle: card.querySelector('.card-state')?.title ?? null,
      preview: card.querySelector('.card-preview')?.textContent ?? null,
      metrics: [...card.querySelectorAll('.card-metrics > span')].map(n => n.textContent),
      height: card.getBoundingClientRect().height,
      overflow: card.scrollWidth - card.clientWidth,
      agentWidth: card.querySelector('.card-agent')?.getBoundingClientRect().width ?? 0,
      modelWidth: card.querySelector('.card-model')?.getBoundingClientRect().width ?? 0,
      attentionRows: card.querySelectorAll('.card-attn-msg').length,
    }))`
    const readUi = () => win.webContents.executeJavaScript(`(() => ({
      cols: window.__term.cols,
      sidebarWidth: document.querySelector('#sidebar').getBoundingClientRect().width,
      buttons: [...document.querySelectorAll('#sidebar-head button')].map(n => n.textContent),
      cards: ${cardsScript},
    }))()`) as Promise<{cols: number; sidebarWidth: number; buttons: string[]; cards: CardUi[]}>
    const afterRender = () => win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))',
    )
    let initialCols = 0
    at(1400, () => {
      sm.writeTo(a.id, "printf 'Codex 状態表示テスト: 実行中\\n'\r")
      sm.writeTo(b.id, "printf 'Codex 状態表示テスト: 承認待ち\\n'\r")
      sm.writeTo(c.id, "printf 'Claude Code 状態表示テスト: 待機 CLAUDE_PREVIEW_OK\\n'\r")
      sm.writeTo(d.id, "printf '通常ターミナル SHELL_PREVIEW_OK\\n'\r")
      sm.writeTo(e.id, "printf 'Codex 通知未取得 UNKNOWN_PREVIEW_OK\\n'\r")
      sm.setCodexProcess(e.id, 'ui-run-1', 'start')
      for (const s of [a, b]) {
        hook(s.id, 'SessionStart', {source: 'startup', usage: {
          totalTokens: s.id === a.id ? 632156 : 98543,
          contextPct: s.id === a.id ? 64 : 18,
          rateLimits: [{remainingPct: 72, windowMinutes: 300}, {remainingPct: 89, windowMinutes: 10080}],
        }})
        hook(s.id, 'UserPromptSubmit')
      }
      hook(b.id, 'PermissionRequest', {toolKey: 'test-command', message: approvalMessage})
      sm.setHookState(c.id, 'idle')
      sm.applyStatus(c.id, claudeStatus)
    })
    at(3300, () => {
      void win.webContents.executeJavaScript(`(() => {
        document.querySelector('.card[data-id="${b.id}"]')?.click()
        return window.__term.cols
      })()`).then((cols: number) => { initialCols = cols }).catch((e) => { scenarioFailure = e })
    })
    at(4000, () => {
      void (async () => {
        // macOS の別ウィンドウにフォーカスが移っていても、実際の入力操作と同じ条件で試す。
        win.focus()
        await win.webContents.executeJavaScript('window.__term.focus()')
        for (const ch of "printf 'CODEX_%s\\n' INPUT_OK") {
          win.webContents.sendInputEvent({type: 'char', keyCode: ch})
        }
        win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'})
        win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'})
        win.setSize(1200, 800)
      })().catch((e) => { scenarioFailure = e })
    })
    at(5500, () => {
      scenarioTask = (async () => {
        try {
          const ui = await readUi()
          if (sm.activeId !== b.id || !sm.serializeSession(b.id)?.includes('CODEX_INPUT_OK')) {
            throw new Error(`Codex card switching / keyboard input failed: active=${sm.activeId}, expected=${b.id}, focused=${win.isFocused()}`)
          }
          if (!(ui.cols > 1 && ui.cols < initialCols) || Math.abs(ui.sidebarWidth - 420) > 1 ||
              ui.buttons.join(',') !== '＋ new' || ui.cards.length !== 5) {
            throw new Error(`Codex card rendering / resize failed: ${JSON.stringify(ui)}`)
          }
          const expectedAi = [
            {id: a.id, agent: 'Codex', model: 'test-model', state: '実行中',
              metrics: ['コンテキスト残約64%', '累計632,156 tok', '5時間残72%', '週間残89%']},
            {id: b.id, agent: 'Codex', model: 'test-model', state: '承認待ち',
              metrics: ['コンテキスト残約18%', '累計98,543 tok', '5時間残72%', '週間残89%']},
            {id: c.id, agent: 'Claude Code', model: 'Opus 4.6', state: '待機',
              metrics: ['コンテキスト残42%', '$1.23']},
            {id: e.id, agent: 'Codex', model: null, state: '状態未取得', metrics: []},
          ]
          for (const expected of expectedAi) {
            const card = ui.cards.find((item) => item.id === expected.id)
            if (!card?.title || card.agent !== expected.agent || card.model !== expected.model ||
                card.state !== expected.state || card.preview !== null || card.attentionRows !== 0 ||
                card.height <= 0 || card.height > 105 || card.agentWidth <= 0 ||
                (expected.model !== null && card.modelWidth <= 0) ||
                JSON.stringify(card.metrics) !== JSON.stringify(expected.metrics)) {
              throw new Error(`Compact AI card failed: ${JSON.stringify({expected, card})}`)
            }
          }
          const shell = ui.cards.find((card) => card.id === d.id)
          if (shell?.agent !== null || shell.model !== null || !shell.preview?.includes('SHELL_PREVIEW_OK') ||
              ui.cards.find((card) => card.id === b.id)?.stateTitle !== approvalMessage) {
            throw new Error(`Shell preview / attention tooltip failed: ${JSON.stringify(ui.cards)}`)
          }

          // Claude を終了した同じカードが通常シェルのプレビューへ戻ることを確認する。
          sm.setHookState(c.id, 'clear')
          await afterRender()
          const cleared = (await readUi()).cards.find((card) => card.id === c.id)
          if (cleared?.agent !== null || cleared.model !== null || cleared.metrics.length !== 0 ||
              !cleared.preview?.includes('CLAUDE_PREVIEW_OK')) {
            throw new Error(`Claude exit did not restore terminal preview: ${JSON.stringify(cleared)}`)
          }
          sm.setHookState(c.id, 'idle')
          sm.applyStatus(c.id, claudeStatus)
          await afterRender()
          const restored = (await readUi()).cards.find((card) => card.id === c.id)
          if (restored?.agent !== 'Claude Code' || restored.model !== 'Opus 4.6' || restored.preview !== null) {
            throw new Error(`Idle Claude card did not hide terminal preview: ${JSON.stringify(restored)}`)
          }

          // hook が一度も届かなかった Codex も、終了後だけ通常シェルへ戻す。
          sm.setCodexProcess(e.id, 'ui-run-1', 'exit')
          await afterRender()
          const codexExited = (await readUi()).cards.find((card) => card.id === e.id)
          if (codexExited?.agent !== null || !codexExited.preview?.includes('UNKNOWN_PREVIEW_OK')) {
            throw new Error(`Unhooked Codex exit did not restore terminal preview: ${JSON.stringify(codexExited)}`)
          }
          sm.setCodexProcess(e.id, 'ui-run-2', 'start')
          await afterRender()

          // 最小幅ではモデルを省略表示できるが、バッジを潰したりカード外へ横溢れさせない。
          const narrow = await win.webContents.executeJavaScript(`(() => {
            const sidebar = document.querySelector('#sidebar')
            const previousWidth = sidebar.style.width
            try {
              sidebar.style.width = '260px'
              return {sidebarWidth: sidebar.getBoundingClientRect().width, cards: ${cardsScript}}
            } finally {
              sidebar.style.width = previousWidth
            }
          })()`) as {sidebarWidth: number; cards: CardUi[]}
          if (Math.abs(narrow.sidebarWidth - 260) > 1 || narrow.cards.some((card) => card.overflow > 1) ||
              expectedAi.some((expected) => {
                const card = narrow.cards.find((item) => item.id === expected.id)
                return !card || card.agent !== expected.agent || card.model !== expected.model ||
                  card.agentWidth <= 0 || (expected.model !== null && card.modelWidth <= 0) || card.preview !== null
              })) {
            throw new Error(`Narrow sidebar card layout failed: ${JSON.stringify(narrow)}`)
          }
          console.log('[codex-ui] compact AI cards with/without hooks, provider/model labels, metrics, shell previews, attention tooltip, switching, keyboard input and resize PASS')

          fs.writeFileSync(`${out}.before.png`, (await win.webContents.capturePage()).toPNG())
          // 実測した Codex のタイトルを PTY 経由で再生。コマンドは承認後も動き続ける。
          sm.writeTo(b.id,
            "printf '\\033]0;[ ! ] Action Required | work\\007'; sleep 0.2; " +
            "printf '\\033]0;⠋ work\\007承認済みの処理を実行中\\n'; sleep 3; printf 'APPROVAL_%s\\n' COMMAND_DONE\r")
          const deadline = Date.now() + 2000
          while (sm.currentUpdate().sessions.find((s) => s.id === b.id)?.state !== 'running' && Date.now() < deadline) {
            await new Promise<void>((resolve) => setTimeout(resolve, 50))
          }
          await afterRender()
          const resumed = (await readUi()).cards.find((card) => card.id === b.id)
          if (resumed?.state !== '実行中' || resumed.stateTitle === approvalMessage ||
              sm.serializeSession(b.id)?.includes('APPROVAL_COMMAND_DONE')) {
            throw new Error(`Codex approval resume before command completion failed: ${JSON.stringify(resumed)}`)
          }
          console.log('[codex-ui] approval changes to running before the command completes PASS')
        } catch (error) {
          scenarioFailure = error instanceof Error ? error : new Error(String(error))
        }
      })()
    })
  } else if (scenario === 'ruler') {
    // PTY が報告する cols と実際に描画される幅の一致を検証する。
    // CLAUDE_TERM_ZOOM=<zoomLevel> でズーム変更後(⌘+/⌘-)の幅計算も検証できる
    const a = sm.create()
    sm.attach(a.id)
    // zoomLevel は Electron がプロファイルに永続化するため、毎回明示的に設定する
    const zoom = Number(process.env.CLAUDE_TERM_ZOOM ?? '0')
    at(800, () => win.webContents.setZoomLevel(Number.isFinite(zoom) ? zoom : 0))
    at(1500, () => sm.writeTo(a.id, `clear; ${rulerCmd}`))
    at(4500, () => {
      void win.webContents
        .executeJavaScript(`(() => {
          const w = (sel) => document.querySelector(sel)?.getBoundingClientRect()?.width
          const vp = document.querySelector('.xterm-viewport')
          // 描画ドリフト: 最も長い行の実インク右端が行ボックス右端をどれだけ超えるか。
          // 正のとき右端の文字がクリップされる(WidthCache の測定精度の検証)
          const rowsBox = document.querySelector('.xterm-rows')?.getBoundingClientRect()
          let drift = null
          for (const row of document.querySelectorAll('.xterm-rows > div')) {
            for (const span of row.children) {
              const b = span.getBoundingClientRect()
              const d = b.x + b.width - (rowsBox.x + rowsBox.width)
              if (drift === null || d > drift) drift = d
            }
          }
          return JSON.stringify({
            host: w('#term-host'),
            xterm: w('.xterm'),
            screen: w('.xterm-screen'),
            vpClient: vp?.clientWidth,
            vpOffset: vp?.offsetWidth,
            dpr: window.devicePixelRatio,
            drift: drift === null ? null : Number(drift.toFixed(3)),
          })
        })()`)
        .then((s) => console.log('[ruler-dom]', s))
        .catch((err) => console.error('[ruler-dom] failed:', err))
    })
  } else if (scenario === 'swap') {
    // 透過設定の切替(WebGL ↔ DOM レンダラー)後に列数が再計算されることの検証。
    // opacity 100 で起動 → ルーラー表示 → 85 へ切替 → 再表示。
    // 切替の前後どちらのルーラーも右端欠け・折り返しが無ければ正しい
    const a = sm.create()
    sm.attach(a.id)
    at(800, () => win.webContents.setZoomLevel(0))
    at(1500, () => sm.writeTo(a.id, `clear; ${rulerCmd}`))
    at(3000, () => {
      win.webContents.send(CH.settingsUpdate, {
        opacity: 85,
        background: '#0f0f11',
        foreground: '#e4e4e7',
        accent: '#d97757',
      })
    })
    at(4200, () => sm.writeTo(a.id, rulerCmd))
    at(5500, () => {
      sm.writeTo(a.id, 'stty size\r')
      console.log('[swap] sm size', (sm as unknown as {cols: number; rows: number}).cols)
    })
  } else if (scenario === 'resize') {
    // ウィンドウリサイズ後の列数再計算とリフローの検証。
    // 初期サイズでルーラー表示 → CLAUDE_TERM_WINSIZE2=<幅>x<高さ> へ縮小 → 再表示。
    // リサイズ後のルーラーに右端欠け・折り返しが無ければ幅計算は正しい
    const a = sm.create()
    sm.attach(a.id)
    at(800, () => win.webContents.setZoomLevel(0))
    at(1500, () => sm.writeTo(a.id, `clear; ${rulerCmd}`))
    at(3000, () => {
      const w2 = /^(\d+)x(\d+)$/.exec(process.env.CLAUDE_TERM_WINSIZE2 ?? '')
      if (w2) win.setSize(Number(w2[1]), Number(w2[2]))
    })
    at(4500, () => sm.writeTo(a.id, rulerCmd))
    at(6000, () => {
      sm.writeTo(a.id, 'stty size\r')
      void win.webContents
        .executeJavaScript(`(() => {
          const w = (sel) => document.querySelector(sel)?.getBoundingClientRect()?.width
          const vp = document.querySelector('.xterm-viewport')
          const t = window.__term
          const dims = t?._core?._renderService?.dimensions
          const rowEl = document.querySelector('.xterm-rows > div')
          return JSON.stringify({
            host: w('#term-host'),
            xterm: w('.xterm'),
            screen: w('.xterm-screen'),
            vpClient: vp?.clientWidth,
            vpOffset: vp?.offsetWidth,
            cols: t?.cols,
            cssCellW: dims?.css?.cell?.width,
            cssCanvasW: dims?.css?.canvas?.width,
            charW: t?._core?._charSizeService?.width,
            rowW: rowEl?.getBoundingClientRect()?.width,
            rowScrollW: rowEl?.scrollWidth,
          })
        })()`)
        .then((s) => console.log('[resize-dom]', s))
        .catch((err) => console.error('[resize-dom] failed:', err))
    })
  } else if (scenario === 'focus-switch') {
    const a = sm.create() // focus reporting を有効にする TUI 役
    const b = sm.create() // 予期しない入力を検出する待機シェル
    sm.attach(a.id)
    at(1200, () => {
      sm.writeTo(
        a.id,
        "printf '\\e[?1004h'; stty -echo -icanon min 1 time 0; dd bs=1 count=3 of=/dev/null 2>/dev/null; sleep 10\r",
      )
      sm.writeTo(
        b.id,
        "stty -echo -icanon min 1 time 0; dd bs=1 count=3 of=/dev/null 2>/dev/null; echo UNEXPECTED_FOCUS_INPUT; stty sane\r",
      )
    })
    // 両セッションが静穏化してから、実際の renderer のカードクリック経路で切り替える
    at(4500, () => {
      const selector = `.card[data-id="${b.id}"]`
      void win.webContents
        .executeJavaScript(`(() => {
          document.querySelector('.xterm-helper-textarea')?.blur()
          document.querySelector(${JSON.stringify(selector)})?.click()
        })()`)
        .catch((err) => {
          scenarioFailure = new Error(`focus-switch click failed: ${String(err)}`)
        })
    })
    at(5200, () => {
      const info = sm.currentUpdate().sessions.find((s) => s.id === b.id)
      if (info?.state !== 'idle') {
        scenarioFailure = new Error(
          `focus-switch changed idle session state: ${info?.state ?? 'missing'}`,
        )
      }
    })
  }

  at(captureDelay, () => {
    void (async () => {
      let code = 0
      try {
        await scenarioTask
        // 失敗時にも、その時点の欠落を画像に残す。
        if (scenarioFailure) fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG())
        if (scenarioFailure) throw scenarioFailure
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
