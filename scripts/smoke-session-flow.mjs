// 本物の xterm と renderer のストリーム処理を使う。PTY・タイマーだけを観測用に置き換える。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const {Terminal} = require('@xterm/headless')
const built = await esbuild.build({
  stdin: {contents: "export {SessionManager} from './src/main/sessions'; export {TerminalStream} from './src/renderer/terminalStream'", resolveDir: root},
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  packages: 'external', write: false, logLevel: 'silent',
})
const ackOf = (event) => ({id: event.id, epoch: event.epoch, bytes: event.data.length})
function harness() {
  const ptys = []
  const timers = new Set()
  const module = {exports: {}}
  vm.runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports,
    require: (name) => name === 'node-pty' ? {
      spawn() {
        const pty = {
          process: 'codex', pauses: 0, resumes: 0, inputs: [],
          onData(callback) { this.output = callback }, onExit(callback) { this.exit = callback },
          write(data) { this.inputs.push(data) }, resize() {},
          pause() { this.pauses++ }, resume() { this.resumes++ },
          kill() { this.exit({signal: 15}) },
        }
        ptys.push(pty)
        return pty
      },
    } : require(name),
    process: {env: {SHELL: '/bin/sh'}, execPath: process.execPath},
    __dirname: path.join(root, 'dist/main'), Buffer, setTimeout, clearTimeout,
    setInterval(callback) { const timer = {callback, unref() {}}; timers.add(timer); return timer },
    clearInterval(timer) { timers.delete(timer) },
    console: {log() {}},
  })
  const {SessionManager, TerminalStream} = module.exports
  const sm = new SessionManager(0)
  const a = sm.create(), b = sm.create()
  const events = []
  sm.onTermOut = (event) => events.push(event)
  return {sm, a, b, ptys, timers, events, SessionManager, TerminalStream,
    async attach(id) { sm.attach(id); await sm.whenTerminalReady(id) },
    async output(index, data) { ptys[index].output(data); await sm.whenTerminalReady(index ? b.id : a.id) },
    dispose() { sm.disposeAll(); assert.equal(timers.size, 0) },
  }
}

{
  const h = harness()
  const renderer = new Terminal({cols: 80, rows: 24, allowProposedApi: true})
  const stream = new h.TerminalStream(renderer, (input) => h.sm.inputToSession(input), (ack) => h.sm.ack(ack), () => {})
  renderer.onData((data) => stream.input(data))
  try {
    await h.attach(h.a.id)
    await stream.accept(h.events.shift())
    await h.output(0, '\x1b[6n')
    await h.attach(h.b.id)
    // main は B へ切替済み。renderer には A の問い合わせと B の snapshot が残っている。
    await Promise.all(h.events.splice(0).map((event) => stream.accept(event)))
    assert.deepEqual(h.ptys[0].inputs, ['\x1b[1;1R'], '旧画面の応答は元のPTYへ一度だけ戻す')
    assert.deepEqual(h.ptys[1].inputs, [])
    stream.input('typed in B')
    assert.deepEqual(h.ptys[1].inputs, ['typed in B'], '復元後のキーボード入力は新しいPTYへ送る')
    await stream.accept(null)
    stream.input('no session')
    assert.deepEqual(h.ptys[1].inputs, ['typed in B'])
    h.sm.kill(h.a.id)
    h.sm.inputToSession({id: h.a.id, data: '\x1b[1;1R'})
    assert.deepEqual(h.ptys[1].inputs, ['typed in B'], '閉じたセッションの入力も別のPTYへ転送しない')
    console.log('ok   切替前の端末応答・切替後の入力・閉じたセッションの入力を混線させない')
  } finally { renderer.dispose(); h.dispose() }
}

{
  const h = harness()
  try {
    await h.attach(h.a.id)
    h.sm.ack(ackOf(h.events.at(-1)))
    await h.output(0, 'a'.repeat(1_100_000))
    const oldAck = ackOf(h.events.at(-1))
    await h.attach(h.b.id)
    h.sm.ack(ackOf(h.events.at(-1)))
    await h.output(1, 'b'.repeat(1_100_000))
    assert.equal(h.ptys[1].pauses, 1)
    h.sm.ack(oldAck)
    assert.equal(h.ptys[1].resumes, 0, 'A の遅い ACK で B を再開しない')
    h.sm.ack(ackOf(h.events.at(-1)))
    assert.equal(h.ptys[1].resumes, 1, 'B の ACK で再開する')

    await h.attach(h.a.id)
    h.sm.ack(ackOf(h.events.at(-1)))
    await h.output(0, 'c'.repeat(1_100_000))
    const resumes = h.ptys[0].resumes
    h.sm.ack(oldAck)
    assert.equal(h.ptys[0].resumes, resumes, 'A へ戻った後も前回の表示への ACK は無視する')
    h.sm.ack(ackOf(h.events.at(-1)))
    assert.equal(h.ptys[0].resumes, resumes + 1)
    console.log('ok   別セッション・同一セッションの前回表示の ACK を無視し、現在の ACK で再開')
  } finally { h.dispose() }
}

{
  const h = harness()
  try {
    await h.attach(h.a.id)
    for (let i = 0; i < 2; i++) {
      h.ptys[1].output('x'.repeat(1_100_000))
      assert.equal(h.ptys[1].pauses, i + 1, '裏側の出力も閾値で停止する')
      assert.equal(h.ptys[1].resumes, i)
      await h.sm.whenTerminalReady(h.b.id)
      assert.equal(h.ptys[1].resumes, i + 1, '裏側はパースが追いつけば ACK なしで再開する')
    }
    h.ptys[0].output('y'.repeat(1_100_000))
    h.sm.attach(h.b.id)
    assert.equal(h.ptys[0].resumes, 0, '裏へ切り替えた直後もパース待ちが多ければ再開しない')
    await h.sm.whenTerminalReady(h.a.id)
    await h.sm.whenTerminalReady(h.b.id)
    assert.equal(h.ptys[0].resumes, 1)
    console.log('ok   裏セッションの連続出力を制限し、切替中も停止と自動再開を維持')
  } finally { h.dispose() }
}

{
  const h = harness()
  h.dispose()
  for (let i = 0; i < 20; i++) {
    const sm = new h.SessionManager(0)
    assert.equal(h.timers.size, 2)
    sm.disposeAll()
    sm.disposeAll()
    assert.equal(h.timers.size, 0)
    assert.throws(() => sm.create(), /disposed/)
  }
  h.ptys[0].output('late output')
  assert.equal(h.events.length, 0, '終了後の出力は配信しない')
  console.log('ok   ウィンドウを繰り返し開閉してもタイマーが残らず、二重終了や遅延出力も安全')
}

{
  const h = harness()
  const renderer = new Terminal({cols: 80, rows: 24, allowProposedApi: true})
  const acks = [], inputs = [], sizes = []
  let writes = 0
  const originalWrite = renderer.write.bind(renderer)
  renderer.write = (data, callback) => { writes++; originalWrite(data, callback) }
  renderer.onResize((size) => sizes.push([size.cols, size.rows]))
  const stream = new h.TerminalStream(renderer, (input) => inputs.push(input), (ack) => acks.push(ack), () => {})
  renderer.onData((data) => stream.input(data))
  try {
    await stream.accept({kind: 'snapshot', id: 'a', epoch: 1, data: '', cols: 80, rows: 24})
    const pending = []
    const data = 'x'.repeat(1024)
    for (let i = 0; i < 128; i++) pending.push(stream.accept({kind: 'data', id: 'a', epoch: 1, data}))
    pending.push(stream.accept({kind: 'resize', id: 'a', epoch: 1, cols: 100, rows: 30, reflowCursorLine: true}))
    const lastA = '\r\nA_DONE\r\n\x1b[6n'
    pending.push(stream.accept({kind: 'data', id: 'a', epoch: 1, data: lastA}))
    pending.push(stream.accept({kind: 'snapshot', id: 'b', epoch: 2, data: 'B_SCREEN\r\n', cols: 80, rows: 24}))
    pending.push(stream.accept({kind: 'data', id: 'b', epoch: 2, data: 'B_END'}))
    await Promise.all(pending)
    assert.equal(stream.busy, false)
    assert(writes < 16, `1KBごとに待たずにまとめてパースする (writes=${writes})`)
    assert.equal(acks.filter((ack) => ack.id === 'a' && ack.epoch === 1).reduce((sum, ack) => sum + ack.bytes, 0),
      128 * data.length + lastA.length, '処理完了した全データを対応する世代へ一度だけ ACK する')
    assert.deepEqual(sizes, [[100, 30], [80, 24]], 'まとめ処理でもサイズ変更を追い越さない')
    assert.equal(inputs.length, 1)
    assert.equal(inputs[0].id, 'a', 'バッチ末尾の問い合わせも切替前の画面に返す')
    assert.equal(renderer.buffer.active.getLine(0).translateToString(true), 'B_SCREEN')
    assert.equal(renderer.buffer.active.getLine(1).translateToString(true), 'B_END', 'snapshot の後へ旧データを混ぜない')
    console.log('ok   連続出力をまとめてパースし、リサイズ・端末応答・snapshot・ACK の順序を保持')
  } finally { renderer.dispose(); h.dispose() }
}
console.log('SESSION FLOW SMOKE PASS')
