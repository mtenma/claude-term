import type {BrowserWindow} from 'electron'
import {Terminal as HeadlessTerminal} from '@xterm/headless'
import {CH} from '../shared/types'
import type {SessionManager} from './sessions'

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

interface TerminalView {
  cols: number
  rows: number
  text: string
  dom: boolean
  overflow: number
}

/** 実際の PTY・IPC・DOM/WebGL を通して、幅変更後も日本語と続きの出力を保持するか検証する。 */
export async function checkResizeWrapping(win: BrowserWindow, sm: SessionManager): Promise<void> {
  const read = () => win.webContents.executeJavaScript(`(() => {
    const t = window.__term
    const b = t.buffer.active
    let text = ''
    for (let i = 0; i < b.length; i++) text += b.getLine(i)?.translateToString(true) ?? ''
    let overflow = 0
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      for (const span of row.children) {
        overflow = Math.max(overflow, span.getBoundingClientRect().right - row.getBoundingClientRect().right)
      }
    }
    return {cols: t.cols, rows: t.rows, text, overflow,
      dom: document.querySelectorAll('.xterm-rows').length > 0}
  })()`) as Promise<TerminalView>
  const until = async (label: string, test: (view: TerminalView) => boolean): Promise<TerminalView> => {
    const deadline = Date.now() + 6000
    let view = await read()
    while (!test(view)) {
      if (Date.now() >= deadline) throw new Error(`${label}: ${JSON.stringify(view)}`)
      await delay(30)
      view = await read()
    }
    return view
  }
  const expectText = async (expected: string, label: string): Promise<void> => {
    const view = await read()
    if (view.text !== expected || view.overflow > 1.5) {
      throw new Error(`${label}: ${JSON.stringify({expected, ...view})}`)
    }
  }
  const sidebarWidth = async (width: number) => {
    await win.webContents.executeJavaScript(`document.querySelector('#sidebar').style.width = '${width}px'`)
  }

  win.webContents.setZoomLevel(0)
  await delay(800)
  // 後で戻るシェルは、出力中の別セッションを切り替えても壊れないことの対照に使う。
  const shell = sm.create()
  sm.attach(shell.id)
  await until('shell prompt', (view) => view.text.trim().length > 0)
  await delay(150)
  sm.writeTo(shell.id, "printf '\\nSHELL_HISTORY_OK\\n'\r")
  await until('shell startup', (view) => view.text.includes('SHELL_HISTORY_OK'))

  for (const opacity of [85, 100]) {
    win.webContents.send(CH.settingsUpdate, {
      opacity, background: '#0f0f11', foreground: '#e4e4e7', accent: '#d97757',
    })
    await sidebarWidth(420)
    await delay(300)
    const session = sm.create()
    sm.attach(session.id)
    await delay(200)
    const initial = await read()
    let expected = 'x'.repeat(initial.cols - 4) + 'プロジェクトの工程制御はプログラムに任せる。'
    // shell の再描画を伴わない出力途中の行。raw input をそのまま返して追記も検証する。
    const program = `process.stdin.setRawMode(true); process.stdin.resume(); ` +
      `process.stdout.write(${JSON.stringify('\x1b[3J\x1b[2J\x1b[H' + expected)}); ` +
      `process.stdin.on('data', data => process.stdout.write(data))`
    sm.writeTo(session.id, `ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} -e ${quote(program)}\r`)
    await until('initial Japanese output', (view) => view.text === expected)

    await sidebarWidth(452)
    await until('sidebar shrink', (view) => view.cols < initial.cols)
    await expectText(expected, 'Japanese characters after shrink')
    sm.writeTo(session.id, '続き')
    expected += '続き'
    await until('continuation after shrink', (view) => view.text.endsWith('続き'))
    await expectText(expected, 'cursor after shrink')

    await sidebarWidth(420)
    await until('sidebar expand', (view) => view.cols === initial.cols)
    await expectText(expected, 'Japanese characters after expand')
    sm.writeTo(session.id, '追記')
    expected += '追記'
    await until('continuation after expand', (view) => view.text.endsWith('追記'))
    await expectText(expected, 'cursor after expand')

    // 連続した幅変更と出力を混ぜる。キー入力が現在の文字を上書きしてはいけない。
    for (const [index, width] of [500, 360, 460, 400, 420].entries()) {
      await sidebarWidth(width)
      sm.writeTo(session.id, `追加${index}`)
      expected += `追加${index}`
      await delay(40)
    }
    await until('rapid resize completion', (view) => view.cols === initial.cols && view.text.endsWith('追加4'))
    await expectText(expected, 'rapid resize while streaming')

    const [windowWidth, windowHeight] = win.getSize()
    win.setSize(windowWidth - 96, windowHeight - 32)
    await until('window shrink', (view) => view.cols < initial.cols && view.rows < initial.rows)
    await expectText(expected, 'window width and height shrink')
    sm.writeTo(session.id, 'ウィンドウ追記')
    expected += 'ウィンドウ追記'
    await until('window resize continuation', (view) => view.text.endsWith('ウィンドウ追記'))
    await expectText(expected, 'cursor after window resize')
    win.setSize(windowWidth, windowHeight)
    await until('window expand', (view) => view.cols === initial.cols && view.rows === initial.rows)
    await expectText(expected, 'window width and height restored')

    await win.webContents.executeJavaScript(`document.querySelector('.card[data-id="${shell.id}"]').click()`)
    await until('switch to shell', (view) => view.text.includes('SHELL_HISTORY_OK'))
    await win.webContents.executeJavaScript(`document.querySelector('.card[data-id="${session.id}"]').click()`)
    await until('snapshot after switching', (view) => view.text === expected)
    await expectText(expected, 'snapshot after resizing and switching')
    const view = await read()
    if (opacity === 85 && !view.dom) throw new Error('Transparent test did not use the DOM renderer')
    console.log(`[resize-wrap] opacity=${opacity} renderer=${view.dom ? 'DOM' : 'WebGL'} cols=${view.cols} Japanese text, continuation and switching PASS`)
    sm.kill(session.id)
  }

  // 編集中の長い zsh 入力はシェル自身も再描画する。実際に実行して入力と履歴の保全を確かめる。
  sm.attach(shell.id)
  await until('return to editable shell', (view) => view.text.includes('SHELL_HISTORY_OK'))
  const shellView = await read()
  const initialCols = shellView.cols
  // zsh のリサイズ再描画は xterm 本来の挙動と比較する。未変更の xterm でも古い編集行が
  // 残る幅があるため、それを今回の再折り返しで増やしたり入力を失ったりしないことを検証する。
  const native = new HeadlessTerminal({cols: shellView.cols, rows: shellView.rows, scrollback: 5000, allowProposedApi: true})
  await new Promise<void>((resolve) => native.write(sm.serializeSession(shell.id) ?? '', resolve))
  let nativeTail = Promise.resolve()
  let wrongShellPolicy = false
  const forwardOutput = sm.onTermOut
  sm.onTermOut = (payload) => {
    if (payload.id === shell.id) {
      nativeTail = nativeTail.then(async () => {
        if (payload.kind === 'resize') {
          wrongShellPolicy ||= payload.reflowCursorLine
          native.resize(payload.cols, payload.rows)
          return
        }
        if (payload.kind === 'snapshot') {
          native.reset()
          native.resize(payload.cols, payload.rows)
        }
        await new Promise<void>((resolve) => native.write(payload.data, resolve))
      })
    }
    forwardOutput(payload)
  }
  const argument = 'プロジェクト'.repeat(20)
  const command = `printf '\\nSHELL_RESULT<%s>\\n' '${argument}'`
  win.focus()
  await win.webContents.executeJavaScript('window.__term.focus()')
  for (const keyCode of command) win.webContents.sendInputEvent({type: 'char', keyCode})
  await delay(150)
  await sidebarWidth(530)
  await until('editing shrink', (view) => view.cols < initialCols)
  await delay(150)
  await sidebarWidth(420)
  await until('editing expand', (view) => view.cols === initialCols)
  await delay(150)
  const editing = await read()
  sm.onTermOut = forwardOutput
  await nativeTail
  const nativeBuffer = native.buffer.active
  let nativeText = ''
  for (let row = 0; row < nativeBuffer.length; row++) nativeText += nativeBuffer.getLine(row)?.translateToString(true) ?? ''
  native.dispose()
  if (wrongShellPolicy || editing.text !== nativeText) {
    throw new Error(`Editable shell differs from native xterm: ${JSON.stringify({wrongShellPolicy, nativeText, ...editing})}`)
  }
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Return'})
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Return'})
  const result = `SHELL_RESULT<${argument}>`
  const view = await until('execute edited input', (current) => current.text.includes(result))
  if (!view.text.includes('SHELL_HISTORY_OK') || view.text.split(result).length !== 2) {
    throw new Error(`Shell history or execution duplicated: ${JSON.stringify(view)}`)
  }
  console.log('[resize-wrap] shell history, long Japanese input, keyboard execution PASS')
}
