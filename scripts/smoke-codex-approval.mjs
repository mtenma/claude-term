// Codex CLI 0.153.4 で観測した OSC タイトルを実際の xterm パーサーへ再生する。
// PTY のみ差し替え、シェル・API・ユーザー設定を使わず承認後の表示更新を検証する。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = await esbuild.build({
  absWorkingDir: root, entryPoints: ['src/main/sessions.ts'], bundle: true,
  platform: 'node', format: 'cjs', target: 'node22', packages: 'external',
  write: false, logLevel: 'silent',
})
const ptys = []
const nodePty = {
  spawn() {
    const pty = {
      process: 'codex', input: [],
      onData(callback) { this.output = callback },
      onExit(callback) { this.exit = callback },
      write(data) { this.input.push(data) },
      resize() {}, pause() {}, resume() {},
      kill() { this.exit({signal: 15}) },
    }
    ptys.push(pty)
    return pty
  },
}
const module = {exports: {}}
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports,
  require: specifier => specifier === 'node-pty' ? nodePty : require(specifier),
  process: {env: {SHELL: '/bin/sh'}, execPath: process.execPath},
  __dirname: path.join(root, 'dist/main'), Buffer, setTimeout, clearTimeout,
  setInterval: () => ({unref() {}}), console: {log() {}},
}, {filename: 'codex-approval.cjs'})

const sm = new module.exports.SessionManager(0)
const a = sm.create()
const b = sm.create()
sm.attach(a.id)
const info = (id = a.id) => sm.currentUpdate().sessions.find(s => s.id === id)
const completed = []
let emitted
sm.onResponseComplete = s => completed.push(s)
sm.onSessionsUpdate = update => { emitted = update }
const hook = (event, extra = {}) => sm.setCodexHook(a.id, JSON.stringify({
  event, sessionId: 'thread', turnId: 'turn', ...extra,
}))
const request = (toolKey, extra = {}) => hook('PermissionRequest', {toolKey, message: `${toolKey} の実行を許可`, ...extra})
const output = async (index, ...chunks) => {
  for (const chunk of chunks) ptys[index].output(chunk)
  await sm.whenTerminalReady(index === 0 ? a.id : b.id)
}
const attention = '\x1b]0;[ ! ] Action Required | work\x07'
const blink = '\x1b]0;[ . ] Action Required | work\x07'
const running = '\x1b]0;⠋ work\x07'

try {
  hook('SessionStart', {source: 'startup'})
  hook('UserPromptSubmit')
  request('slow')
  await output(0, running)
  assert.equal(info().state, 'attention', '承認画面より前の遅れた実行タイトルでは解除しない')
  await output(0, '\x1b]0;[ ! ] Action ', 'Required | work', '\x07')
  sm.inputToActive('\x1b[B')
  sm.inputToActive('\r')
  assert.deepEqual(ptys[0].input.slice(-2), ['\x1b[B', '\r'], '承認の選択と確定キーをそのまま送る')
  sm.resize(100, 30)
  await output(0, blink, '\x1b[2J\x1b[HWould you like to run the following command?', '\x1b]2;⠋ other-project\x1b\\')
  assert.equal(info().state, 'attention', 'キー入力・再描画・点滅・別タイトルでは解除しない')
  sm.attach(b.id)
  await output(0, '\x1b]2;⠙ work\x1b', '\\')
  assert.equal(info().state, 'running', '非アクティブでもコマンド完了前に実行中へ戻る')
  assert.equal(info().attentionMessage, null)
  assert.equal(emitted.sessions.find(s => s.id === a.id).state, 'running', '定期更新を待たず画面へ通知する')
  assert.equal(completed.length, 0, '承認を応答完了として通知しない')
  hook('PreToolUse', {toolKey: 'unrelated'})
  hook('PostToolUse', {toolKey: 'unrelated'})
  assert.equal(info().state, 'running', '別の hook で承認待ちが復活しない')
  request('slow')
  hook('PostToolUse', {toolKey: 'slow'})
  assert.equal(info().state, 'attention', '先に承認した同一コマンドの完了で次の承認を消さない')
  await output(0, attention, running)
  hook('PostToolUse', {toolKey: 'slow'})
  assert.equal(info().state, 'running')
  console.log('ok   Codex の承認直後・分割OSC・裏セッション・同一コマンドの遅延完了')

  request('first')
  request('second')
  await output(0, attention, blink)
  hook('PostToolUse', {toolKey: 'first'})
  assert.equal(info().state, 'attention', '複数の承認のうち一つの完了では解除しない')
  await output(0, running)
  assert.equal(info().state, 'running', '最後の承認後に実行が再開したら解除する')
  hook('PostToolUse', {toolKey: 'second'})

  request('previous')
  await output(0, attention)
  request('new')
  await output(0, running)
  assert.equal(info().state, 'attention', '承認画面を観測した後の新規要求を以前の再開通知で消さない')
  assert.equal(info().attentionMessage, 'new の実行を許可')
  hook('PostToolUse', {toolKey: 'previous'})
  await output(0, attention, running)
  assert.equal(info().state, 'running')
  hook('PostToolUse', {toolKey: 'new'})
  request('child-tool', {agentId: 'child', turnId: 'child-turn'})
  await output(0, attention, running)
  assert.equal(info().state, 'running', '子エージェントの承認も実行完了前に解除する')
  hook('PostToolUse', {toolKey: 'child-tool', agentId: 'child', turnId: 'child-turn'})
  assert.equal(completed.length, 0)
  console.log('ok   Codex の複数承認・新規要求との競合・子エージェント承認')

  request('no-title')
  hook('PostToolUse', {toolKey: 'unrelated'})
  assert.equal(info().state, 'attention')
  hook('PostToolUse', {toolKey: 'no-title'})
  assert.equal(info().state, 'running', 'タイトル通知が無くても従来の完了 hook で解除する')
  request('interrupted')
  await output(0, attention)
  hook('Interrupt')
  await output(0, running, attention)
  assert.equal(info().state, 'idle', '中断後の遅れたタイトルでは復活しない')
  assert.equal(completed.length, 0)
  hook('UserPromptSubmit', {turnId: 'next-turn'})
  request('next', {turnId: 'next-turn'})
  await output(0, running)
  assert.equal(info().state, 'attention', '前ターンの承認画面を新しいターンへ持ち越さない')
  await output(0, attention, running)
  hook('Stop', {turnId: 'next-turn'})
  hook('Stop', {turnId: 'next-turn'})
  await output(0, attention, running)
  assert.equal(info().state, 'idle')
  assert.equal(completed.length, 1, 'Stop による完了通知は一度だけ')
  hook('SessionEnd')
  sm.setCodexProcess(a.id, 'new-cli', 'start')
  await output(0, attention, running)
  assert.equal(info().state, 'unknown', 'hook 未取得の Codex の状態をタイトルだけで決めない')
  sm.setHookState(b.id, 'attention', '{"message":"Claude approval"}')
  await output(1, attention, running)
  assert.equal(info(b.id).state, 'attention', 'Claude の承認待ちは変更しない')
  assert.equal(info(b.id).attentionMessage, 'Claude approval')
  console.log('ok   Codex のタイトル無効時・中断・終了・再起動と Claude の状態分離')
} finally {
  sm.disposeAll()
}
