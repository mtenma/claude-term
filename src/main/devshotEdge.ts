import type {BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CH} from '../shared/types'
import type {SessionManager} from './sessions'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const quote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

interface EdgeView {
  cols: number
  type: string
  text: string
  dom: boolean
  drift: number
  alignment: number
  clipped: number
}

/** 句読点・太字を含む行について、文字の保持と各描画位置の固定セルへの一致を検証する。 */
export async function checkRightEdge(win: BrowserWindow, sm: SessionManager): Promise<void> {
  const read = () => win.webContents.executeJavaScript(`(() => {
    const t = window.__term
    const b = t.buffer.active
    const host = document.querySelector('#term-host').getBoundingClientRect()
    const screen = document.querySelector('.xterm-screen').getBoundingClientRect()
    const rows = [...document.querySelectorAll('.xterm-rows > div')]
    const cellWidth = t._core._renderService.dimensions.css.cell.width
    let drift = 0, alignment = 0, text = ''
    rows.forEach((row, index) => {
      const line = b.getLine(b.viewportY + index)
      const rect = row.getBoundingClientRect()
      let column = 0
      for (const span of row.children) {
        const end = span.getBoundingClientRect().right - rect.left
        let characters = 0
        while (characters < span.textContent.length && column < t.cols) {
          const cell = line.getCell(column)
          characters += (cell.getChars() || ' ').length
          column += cell.getWidth() || 1
        }
        alignment = Math.max(alignment, Math.abs(end - column * cellWidth))
        drift = Math.max(drift, end - rect.width)
      }
    })
    for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) ?? ''
    return {cols: t.cols, type: b.type, text, dom: rows.length > 0,
      drift, alignment, clipped: Math.max(0, screen.right - host.right)}
  })()`) as Promise<EdgeView>
  const expect = async (expected: string, label: string): Promise<EdgeView> => {
    const deadline = Date.now() + 6000
    let view = await read()
    while (view.text !== expected || view.clipped > 0.5) {
      if (Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify(view)}`)
      await delay(30)
      view = await read()
    }
    // write のパース完了と DOM/WebGL の描画完了は別フレームになる。
    await win.webContents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )
    view = await read()
    if (view.text !== expected || view.clipped > 0.5 || view.type !== 'normal' || view.drift > 0.5 || view.alignment > 0.5) {
      throw new Error(`${label}: ${JSON.stringify(view)}`)
    }
    return view
  }
  win.webContents.setZoomLevel(0)
  await delay(500)
  const session = sm.create()
  sm.attach(session.id)
  await delay(500)
  const paragraph = '• プロジェクト側の変更を反映し、既存のworkflowテスト35件が通りました。 共通設定の変更内容も検証済みです。 残る反映先の'
  const next = '  ~/.codex は作業フォルダ外のため、環境の書き込み制限に従って権限確認を行います。'
  const punctuation = '「日本語」、句読点。。。『全角』とASCII35を確認。終端の'
  const lines = [paragraph, next, punctuation, punctuation, punctuation, punctuation]
  const styles = ['1', '1', '0', '1', '3', '1;3']
  const content = '\x1b[3J\x1b[2J\x1b[H' + lines.map((line, index) =>
    `\x1b[0;${styles[index]}m${line}\x1b[0m\r\n`).join('')
  const program = `process.stdin.setRawMode(true); process.stdin.resume(); ` +
    `process.stdout.write(${JSON.stringify(content)}); process.stdin.on('data', data => process.stdout.write(data))`
  const expected = lines.join('')
  // 長い日本語のスクリプトをシェルへ直接貼ると、起動直後の canonical input の
  // 長さ制限で切れることがある。PTY へ送るコマンドは短く保つ。
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-term-edge-'))
  try {
    const fixture = path.join(directory, 'output.cjs')
    fs.writeFileSync(fixture, program)
    sm.writeTo(session.id, `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(fixture)}\r`)
    await expect(expected, 'initial output')
  } finally {
    fs.rmSync(directory, {recursive: true, force: true})
  }
  for (const opacity of [85, 100, 85]) {
    win.webContents.send(CH.settingsUpdate, {
      opacity, background: '#29273f', foreground: '#7aff00', accent: '#7aff00',
    })
    await delay(150)
    let maxAlignment = 0
    for (const width of [1440, 1386, 1394, 1402, 1370, 1340, 1300, 1440]) {
      win.setSize(width, 700)
      await delay(150)
      const view = await expect(expected, `opacity=${opacity} width=${width}`)
      if (opacity < 100 && !view.dom) throw new Error('Transparent test did not use the DOM renderer')
      maxAlignment = Math.max(maxAlignment, view.alignment)
    }
    // キャッシュを再生成するズーム変更でも句読点の測定が揃うことを確認する。
    for (const zoom of [1, -1, 0]) {
      win.webContents.setZoomLevel(zoom)
      await delay(200)
      await expect(expected, `opacity=${opacity} zoom=${zoom}`)
    }
    console.log(`[right-edge] opacity=${opacity} resize, zoom, mixed Japanese, punctuation and all font styles PASS (max alignment error ${maxAlignment.toFixed(3)}px)`)
  }
  const other = sm.create()
  sm.attach(other.id)
  await delay(200)
  await win.webContents.executeJavaScript(`document.querySelector('.card[data-id="${session.id}"]').click()`)
  await delay(200)
  await expect(expected, 'snapshot after switching')
  // 実際のキー入力経路を通して、最後の文字を上書きせず追記されることを確認する。
  win.focus()
  await win.webContents.executeJavaScript('window.__term.focus()')
  for (const keyCode of '追記の') win.webContents.sendInputEvent({type: 'char', keyCode})
  await expect(expected + '追記の', 'continued input')
  win.setSize(1386, 700)
  await delay(150)
  await expect(expected + '追記の', 'final narrow window')
  console.log('[right-edge] snapshot switching and continued input PASS')
}
