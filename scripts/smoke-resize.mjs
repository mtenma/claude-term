// 実際の xterm を2つ使い、main の出力・resize・snapshot を受信側で順番に再生する。
// PTY は偽物なので、ユーザーのシェル・設定・実行中セッションには触れない。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

await import('./smoke-terminal-resize.mjs')

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {Terminal} = require('@xterm/headless')
const {SerializeAddon} = require('@xterm/addon-serialize')
const mirrors = []
const ptys = []
class ObservedTerminal extends Terminal {
  constructor(options) {
    super(options)
    mirrors.push(this)
  }
}
const built = await esbuild.build({
  stdin: {
    contents: "export {SessionManager} from './src/main/sessions'; export {resizeTerminal} from './src/shared/terminalResize'",
    resolveDir: root,
    sourcefile: 'resize-test.ts',
  },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  packages: 'external', write: false, logLevel: 'silent',
})
const module = {exports: {}}
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === '@xterm/headless') return {Terminal: ObservedTerminal}
    if (name === 'node-pty') return {
      spawn() {
        const pty = {
          process: 'codex',
          resizes: [],
          pauses: 0,
          resumes: 0,
          onData(callback) { this.output = callback },
          onExit(callback) { this.exit = callback },
          resize(cols, rows) { this.resizes.push({cols, rows}) },
          write() {},
          pause() { this.pauses++ },
          resume() { this.resumes++ },
          kill() { this.exit({signal: 15}) },
        }
        ptys.push(pty)
        return pty
      },
    }
    return require(name)
  },
  process: {env: {SHELL: '/bin/sh'}, execPath: process.execPath},
  __dirname: path.join(root, 'dist/main'),
  Buffer, setTimeout, clearTimeout,
  setInterval: () => ({unref() {}}),
  console: {log() {}},
}, {filename: 'resize-test.cjs'})
const {SessionManager, resizeTerminal} = module.exports
const write = (term, data) => new Promise((resolve) => term.write(data, resolve))
const textOf = (term) => Array.from({length: term.buffer.active.length}, (_, y) =>
  term.buffer.active.getLine(y).translateToString(true)).join('')

function harness() {
  const sm = new SessionManager(0)
  const session = sm.create()
  const mirror = mirrors.at(-1)
  const pty = ptys.at(-1)
  const renderer = new Terminal({cols: 80, rows: 24, scrollback: 3000, allowProposedApi: true})
  const serialize = new SerializeAddon()
  renderer.loadAddon(serialize)
  const received = []
  let rendererTail = Promise.resolve()
  sm.onTermOut = (event) => {
    received.push(event)
    rendererTail = rendererTail.then(async () => {
      // 寸法変更・reset を write callback 内で再入させず、次のデータも追い越させない。
      if (event.kind === 'snapshot') renderer.reset()
      if (event.kind === 'resize' && !event.reflowCursorLine) renderer.resize(event.cols, event.rows)
      else if (event.kind !== 'data') resizeTerminal(renderer, event.cols, event.rows)
      if (event.kind !== 'resize') {
        await write(renderer, event.data)
        sm.ack(event.data.length)
      }
    })
  }
  sm.attach(session.id)
  return {
    sm, session, mirror, renderer, pty, received,
    output(data) { pty.output(data) },
    async settle() {
      await sm.whenTerminalReady(session.id)
      await rendererTail
    },
    compare() {
      assert.equal(renderer.cols, mirror.cols)
      assert.equal(renderer.rows, mirror.rows)
      assert.equal(serialize.serialize({scrollback: 2000}), sm.serializeSession(session.id),
        '受信したイベントから復元した画面・カーソル・折り返しがmainと一致する')
    },
    dispose() { sm.disposeAll(); renderer.dispose() },
  }
}

async function runCase(label, check) {
  const h = harness()
  try {
    await h.settle()
    await check(h)
    h.compare()
    console.log(`ok   ${label}`)
  } finally {
    h.dispose()
  }
}

const wrapped = 'x'.repeat(76) + 'プロジェクト'
await runCase('改行済みの静的ログは横幅を往復しても全文を保持する', async (h) => {
  h.output(wrapped + '\r\n')
  await h.settle()
  h.sm.resize(76, 24)
  h.sm.resize(80, 24)
  await h.settle()
  assert.equal(textOf(h.mirror), wrapped)
})

for (const appendWhenNarrow of [true, false]) {
  await runCase(`カーソルを含む日本語の折り返しと${appendWhenNarrow ? '縮小直後' : '縮小・拡大後'}の追記`, async (h) => {
    h.output(wrapped)
    await h.settle()
    h.sm.resize(76, 24)
    await h.settle()
    assert.equal(textOf(h.mirror), wrapped, '80→76列でプロを欠落させない')
    assert.equal(h.mirror.buffer.active.cursorX, 12, 'reflow後の論理カーソル位置を維持する')
    if (!appendWhenNarrow) {
      h.sm.resize(80, 24)
      await h.settle()
    }
    h.output('続き')
    await h.settle()
    assert.equal(textOf(h.mirror), wrapped + '続き', '追記で既存のクトを上書きしない')
    h.sm.resize(80, 24)
    await h.settle()
    h.output('更に')
    await h.settle()
    assert.equal(textOf(h.mirror), wrapped + '続き更に')
  })
}

await runCase('未処理の旧寸法出力→resize→新寸法出力を同じ順番で送る', async (h) => {
  const oldWidthOutput = 'x'.repeat(58) + 'プロジェクト' + '\x1b[1;80HZ\r\n'
  h.received.length = 0
  h.output(oldWidthOutput)
  h.sm.resize(60, 24)
  h.output('\x1b[3;1H新寸法の行')
  await h.settle()
  assert.deepEqual(h.received.map((event) => event.kind), ['data', 'resize', 'data'])
  assert.equal(h.received[0].data, oldWidthOutput)
  assert.equal(h.received[1].cols, 60)
  assert.equal(h.received[1].reflowCursorLine, true)
  assert(textOf(h.mirror).includes('プロジェクト'), '旧80列へのカーソル操作を60列で解釈してプを消さない')
  assert(textOf(h.mirror).includes('新寸法の行'))
})

await runCase('resize待機中のattachは実際の寸法と既存出力をsnapshotへ含める', async (h) => {
  h.received.length = 0
  h.output(wrapped)
  h.sm.resize(76, 24)
  h.sm.attach(h.session.id)
  h.output('続き')
  await h.settle()
  assert.deepEqual(h.received.map((event) => event.kind), ['snapshot', 'data'])
  assert.equal(h.received[0].cols, 76)
  assert.equal(h.received[0].rows, 24)
  assert.equal(textOf(h.mirror), wrapped + '続き', '切替前後の出力を欠落・重複させない')
})

await runCase('連続リサイズと出力を交互に受信しても追記位置を保持する', async (h) => {
  h.output(wrapped)
  for (const cols of [76, 92, 61, 80]) {
    h.sm.resize(cols, 24)
    h.output('字')
  }
  await h.settle()
  assert.deepEqual(h.pty.resizes.map(({cols}) => cols), [76, 92, 61, 80])
  assert.equal(textOf(h.mirror), wrapped + '字'.repeat(4))
})

await runCase('前景シェルの行編集はnative resizeへ任せ、同じ方針を受信側へ送る', async (h) => {
  h.pty.process = '-zsh'
  h.output(wrapped)
  await h.settle()
  h.sm.resize(76, 24)
  h.output('\x1b[2J\x1b[H' + wrapped)
  await h.settle()
  assert.equal(h.received.find((event) => event.kind === 'resize').reflowCursorLine, false)
  assert.equal(textOf(h.mirror), wrapped, 'shellが新しい寸法で再描画した入力を保持する')
  h.pty.process = 'codex'
  h.sm.resize(80, 24)
  await h.settle()
  assert.equal(h.received.at(-1).reflowCursorLine, true, '前景プログラムが変わればreflow方針も切り替える')
})

await runCase('parse待ちの出力もflow controlへ含め、古いackで早期再開しない', async (h) => {
  const chunk = 'q'.repeat(110000)
  for (let i = 0; i < 10; i++) h.output(chunk)
  assert.equal(h.pty.pauses, 1, 'xtermがparseする前に1MiB超の出力を止める')
  h.sm.ack(chunk.length * 10)
  assert.equal(h.pty.resumes, 0, 'parse待ちが残る間は古いrendererのackで再開しない')
  await h.settle()
  assert.equal(h.pty.resumes, 1, '処理とackが追いついたらPTYを再開する')
})

console.log('RESIZE SMOKE PASS')
