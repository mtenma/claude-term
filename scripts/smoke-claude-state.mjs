// 実際の xterm パーサーに PTY 出力を再生し、時計を進めて状態判定を検証する。
// シェルは起動せず、ユーザーの設定や実セッションには触れない。
import * as esbuild from 'esbuild'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/main/sessions.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  write: false,
  logLevel: 'silent',
})

let now = 1_000_000
class Clock extends Date {
  static now() { return now }
}
const ptys = []
const terminals = []
const {Terminal} = require('@xterm/headless')
class ObservedTerminal extends Terminal {
  constructor(options) {
    super(options)
    terminals.push(this)
  }
}
const nodePty = {
  spawn() {
    const pty = {
      onData(callback) { this.output = callback },
      onExit(callback) { this.exit = callback },
      write() {}, resize() {}, pause() {}, resume() {},
      kill() { this.exit({signal: 15}) },
    }
    ptys.push(pty)
    return pty
  },
}
const module = {exports: {}}
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports,
  require: (specifier) => {
    if (specifier === 'node-pty') return nodePty
    if (specifier === '@xterm/headless') return {Terminal: ObservedTerminal}
    return require(specifier)
  },
  Date: Clock,
  process: {env: {SHELL: '/bin/sh'}, execPath: process.execPath},
  __dirname: path.join(root, 'dist/main'),
  Buffer, setTimeout, clearTimeout,
  setInterval: () => ({unref() {}}),
  console: {log() {}},
}, {filename: 'claude-state.cjs'})

const sm = new module.exports.SessionManager(0)
const completions = []
sm.onResponseComplete = (info) => completions.push(info)
const a = sm.create()
const b = sm.create()
sm.attach(a.id)
const info = (id = a.id) => sm.currentUpdate().sessions.find((s) => s.id === id)
const output = async (index, ...chunks) => {
  for (const chunk of chunks) ptys[index].output(chunk)
  await sm.whenTerminalReady(sm.currentUpdate().sessions[index].id)
}
const prompt = '\x1b[2J\x1b[H> '
const idleNotification = JSON.stringify({hook_event_name: 'Notification', notification_type: 'idle_prompt'})

try {
  sm.setHookState(a.id, 'idle')
  await output(0, prompt)
  sm.setHookState(a.id, 'running')
  now += 40_000
  await output(0, '\x1b[2J\x1b[H')
  assert.equal(info().state, 'running')
  now += 20
  await output(0, '> ')
  now += 18_980
  await output(0, '\x1b[?25l', prompt, '\x1b[?25h')
  assert.equal(info().state, 'running', '中断直後は直前の実行状態を保つ')
  now += 2000
  await output(0, prompt)
  assert.equal(info().state, 'idle', '同じ画面の再描画は60秒の活動猶予を延長しない')
  now += 1000
  await output(0, '\x1b]0;Claude Code\x07', '\x1b[?25l\x1b[?25h')
  assert.equal(info().state, 'idle', 'タイトルやカーソル制御でも待機から復活しない')
  await output(0, '\x1b[2J\x1b[H')
  now += 20
  await output(0, '> ')
  assert.equal(info().state, 'idle', '別々に到着する画面消去と再描画でも実行中に戻さない')
  await output(0, 'まだ送信していない下書き')
  assert.equal(info().state, 'idle', '下書きの入力エコーでも実行中に戻さない')
  assert.equal(completions.length, 0, '静穏化を応答完了として通知しない')
  sm.resize(100, 30)
  await Promise.all(sm.currentUpdate().sessions.map(({id}) => sm.whenTerminalReady(id)))
  now += 1100
  await output(0, prompt)
  assert.equal(info().state, 'idle', 'リサイズ後の再描画でも待機のまま')
  console.log('ok   Claude の中断後・同一画面再描画・カーソル制御・リサイズ')

  sm.setHookState(a.id, 'running')
  assert.equal(info().state, 'running', '次の実行通知では待機から実行中に戻す')
  now += 55_000
  await output(0, '\x1b[2J\x1b[HThinking 1')
  now += 10_000
  assert.equal(info().state, 'running', '実際の表示内容の変化は活動として扱う')
  now += 45_000
  await output(0, '\x1b[2J\x1b[HThinking 2')
  now += 10_000
  assert.equal(info().state, 'running', '60秒を超える処理でも出力が進む間は実行中を維持')
  now += 50_001
  await output(0, '\x1b[?25h')
  assert.equal(info().state, 'idle', '表示内容の変化が途絶えた場合は待機へ戻す')
  sm.setHookState(a.id, 'idle')
  assert.equal(completions.length, 1, '無出力の待機推定後も、本当の Stop では完了を通知する')
  completions.length = 0
  console.log('ok   Claude の実際の出力進行は活動猶予を延長する')

  sm.setHookState(a.id, 'running')
  sm.setHookState(a.id, 'idle', idleNotification)
  assert.equal(info().state, 'idle')
  assert.equal(completions.length, 0, 'idle_prompt を応答完了として通知しない')
  sm.setHookState(a.id, 'attention', '{"message":"承認してください"}')
  sm.setHookState(a.id, 'idle', idleNotification)
  assert.equal(info().attentionMessage, null, '入力待ちに戻ったら承認メッセージを消す')
  assert.equal(completions.length, 0)
  sm.setHookState(a.id, 'running')
  sm.setHookState(a.id, 'idle') // 既存 Stop hook の本文なしリクエスト
  sm.setHookState(a.id, 'idle')
  sm.setHookState(a.id, 'idle', idleNotification)
  assert.equal(completions.length, 1, 'Stop だけが一度完了を通知する')
  await output(0, '\r\nnew prompt')
  assert.equal(info().state, 'idle', '待機通知後は通常の出力でも実行中に戻さない')
  console.log('ok   Claude の入力待ち復帰と応答完了通知の区別')

  sm.setHookState(b.id, 'running')
  now += 60_001
  await output(1, '\x1b]9;4;0;\x07')
  assert.equal(info(b.id).state, 'idle', '非アクティブの進捗バー制御を承認待ちと誤認しない')
  await output(1, '\x1b]9;確認してください\x07')
  assert.equal(info(b.id).state, 'attention', '実際の OSC 9 通知は承認待ちのまま扱う')

  const c = sm.create()
  await output(2, 'shell output')
  assert.equal(info(c.id).state, 'running')
  now += 2600
  assert.equal(info(c.id).state, 'idle')
  await output(2, '\r\nnext output')
  assert.equal(info(c.id).state, 'running', 'hook のないシェルは従来の出力判定を使う')
  console.log('ok   進捗制御と通知の区別・通常シェルの出力判定')
} finally {
  sm.disposeAll()
}

console.log('CLAUDE STATE SMOKE PASS')
