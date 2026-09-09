// Exercise the real pinned xterm parser/reflow without a PTY, GUI or user settings.
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const {Terminal} = require('@xterm/headless')
await esbuild.build({
  entryPoints: ['src/shared/terminalResize.ts'], outfile: 'dist-test/terminalResize.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'silent',
})
const {resizeTerminal} = require('../dist-test/terminalResize.cjs')
const terminals = []
function terminal(cols = 80, rows = 8, scrollback = 30) {
  const term = new Terminal({cols, rows, scrollback, allowProposedApi: true})
  terminals.push(term)
  return term
}
const write = (term, data) => new Promise((resolve) => term.write(data, resolve))
function logicalLines(term, buffer = term.buffer.normal) {
  const result = []
  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row)
    const next = row + 1 < buffer.length ? buffer.getLine(row + 1) : undefined
    let end = term.cols
    if (next?.isWrapped && !line.getCell(end - 1).getChars() &&
        line.getCell(end - 1).getWidth() === 1 && next.getCell(0).getWidth() === 2) end--
    const text = line.translateToString(!next?.isWrapped, 0, end)
    if (line.isWrapped && result.length) result[result.length - 1] += text
    else result.push(text)
  }
  while (result.at(-1) === '') result.pop()
  return result
}
function screen(term) {
  const buffer = term.buffer.active
  return {
    x: buffer.cursorX, y: buffer.cursorY, base: buffer.baseY,
    rows: Array.from({length: buffer.length}, (_,row) => ({
      wrapped: buffer.getLine(row).isWrapped,
      text: buffer.getLine(row).translateToString(true),
    })),
  }
}

try {
  const text = 'x'.repeat(76) + 'プロジェクト'
  const project = terminal()
  await write(project, '\x1b[?2004h\x1b[31;1m' + text)
  const modes = project.modes
  let resizeCursor
  project.onResize(() => { resizeCursor = project.buffer.normal.cursorX })
  resizeTerminal(project, 76, 8)
  assert.deepEqual(logicalLines(project), [text], 'shrinking must retain プロ')
  assert.equal(project.buffer.normal.cursorX, 12, 'cursor follows all six wide characters')
  assert.equal(resizeCursor, 12, 'public resize listeners see the corrected cursor')
  await write(project, '続き')
  resizeTerminal(project, 80, 8)
  assert.deepEqual(logicalLines(project), [text + '続き'], 'continuing after resize must not overwrite クト')
  assert.deepEqual(project.modes, modes, 'resize must not change terminal modes')
  const colored = project.buffer.normal.getLine(1).getCell(0)
  assert.equal(colored.getFgColor(), 1, 'reflow retains foreground attributes')
  assert.ok(colored.isBold(), 'reflow retains bold attributes')

  const boundary = terminal(10, 5)
  await write(boundary, 'abcdefghij')
  resizeTerminal(boundary, 5, 4)
  assert.equal(boundary.buffer.normal.cursorX, 5, 'full right margin retains pending wrap')
  await write(boundary, '続き')
  resizeTerminal(boundary, 10, 5)
  assert.deepEqual(logicalLines(boundary), ['abcdefghij続き'])
  const heightOnly = terminal(10, 5)
  await write(heightOnly, 'abcdefghij')
  resizeTerminal(heightOnly, 10, 3)
  await write(heightOnly, 'Z')
  assert.deepEqual(logicalLines(heightOnly), ['abcdefghijZ'], 'height-only resize retains pending wrap')

  const wideEdge = terminal(10, 8)
  await write(wideEdge, 'abcdefghiプロジェクト')
  for (const cols of [6, 9, 7, 10]) {
    resizeTerminal(wideEdge, cols, 8)
    assert.deepEqual(logicalLines(wideEdge), ['abcdefghiプロジェクト'], `CJK padding is not a space at ${cols} columns`)
  }
  await write(wideEdge, '続き')
  assert.deepEqual(logicalLines(wideEdge), ['abcdefghiプロジェクト続き'])

  const middle = terminal(12, 10)
  await write(middle, 'abcdefghijklmnopqrstuvwx\r\nTAIL\x1b[1A\x1b[3G')
  resizeTerminal(middle, 5, 10)
  assert.equal(middle.buffer.normal.cursorX, 4)
  assert.equal(middle.buffer.normal.cursorY, 2)
  await write(middle, 'Z')
  resizeTerminal(middle, 12, 10)
  assert.deepEqual(logicalLines(middle), ['abcdefghijklmnZpqrstuvwx', 'TAIL'], 'editing an earlier wrapped row preserves surrounding content')

  const scrolling = terminal(10, 3, 60)
  await write(scrolling, 'history\r\n'.repeat(6) + 'a'.repeat(50) + 'プロジェクト')
  const before = logicalLines(scrolling)
  scrolling.scrollToTop()
  resizeTerminal(scrolling, 7, 2)
  assert.ok(scrolling.buffer.normal.viewportY < scrolling.buffer.normal.baseY, 'resize retains a scrolled-up viewport')
  assert.deepEqual(logicalLines(scrolling), before)
  resizeTerminal(scrolling, 10, 4)
  await write(scrolling, '続き')
  assert.deepEqual(logicalLines(scrolling), [...before.slice(0, -1), before.at(-1) + '続き'])

  const trimming = terminal(10, 3, 3)
  await write(trimming, 'a'.repeat(50) + 'プロジェクト')
  resizeTerminal(trimming, 7, 2)
  await write(trimming, '続き')
  assert.ok(logicalLines(trimming).at(-1).endsWith('プロジェクト続き'), 'scrollback trimming must not misplace the live cursor')

  const alternate = terminal(12, 6)
  const native = terminal(12, 6)
  const alternateInput = '\x1b[?1049h\x1b[2Jabcdefghijklmnopqrstuvwx\x1b[2;3H'
  await write(alternate, text + alternateInput)
  await write(native, text + alternateInput)
  resizeTerminal(alternate, 7, 4)
  native.resize(7, 4)
  assert.deepEqual(screen(alternate), screen(native), 'alternate buffer retains native resize semantics')
  await write(alternate, '\x1b[?1049l')
  assert.deepEqual(logicalLines(alternate), [text], 'normal content also survives resize while alternate screen is active')
  await write(alternate, '続き')
  assert.deepEqual(logicalLines(alternate), [text + '続き'], 'returning from alternate screen restores the logical saved cursor')

  console.log('TERMINAL RESIZE SMOKE PASS: CJK, cursor, pending wrap, attributes, scrollback and alternate screen')
} finally {
  for (const term of terminals) term.dispose()
}
