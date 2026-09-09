// Codex の実際の relay → HTTP → SessionManager と、複数セッションの状態遷移を検証する。
// Codex 本体・API・ユーザー設定は使わず、hook の stdin と同じ形式を入力する。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import {spawn} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import {fileURLToPath} from 'node:url'

await import('./smoke-codex-approval.mjs')

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)
const require = createRequire(import.meta.url)
await esbuild.build({
  entryPoints: ['sessions', 'hookServer', 'codexEvents', 'codexHookRelay', 'codexUsage', 'shellIntegration', 'codexHooksSettings'].map((n) => `src/main/${n}.ts`),
  outdir: 'dist-test/codex', outExtension: {'.js': '.cjs'},
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['node-pty'], logLevel: 'silent',
})
const {SessionManager, whenAllPtysExited} = require(path.join(root, 'dist-test/codex/sessions.cjs'))
const {startHookServer} = require(path.join(root, 'dist-test/codex/hookServer.cjs'))
const {projectCodexEvent} = require(path.join(root, 'dist-test/codex/codexEvents.cjs'))
const {readCodexUsage, parseCodexUsage} = require(path.join(root, 'dist-test/codex/codexUsage.cjs'))
const {CODEX_FUNCTION_BODY, configureShellIntegration} = require(path.join(root, 'dist-test/codex/shellIntegration.cjs'))
const {withCodexTermHooks, CODEX_RELAY_COMMAND} = require(path.join(root, 'dist-test/codex/codexHooksSettings.cjs'))
const relayPath = path.join(root, 'dist-test/codex/codexHookRelay.cjs')
const relayExecutable = require('electron')
const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
// 実際に登録する command と同じ経路で、Electron 自身の診断出力も hook に漏らさない。
const relayCommand = withCodexTermHooks({}, CODEX_RELAY_COMMAND).hooks.SessionStart[0].hooks[0].command
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-term-codex-smoke-'))
const transcript = path.join(tmp, 'usage.jsonl')
const jsonLine = (data) => `${JSON.stringify(data)}\n`
const tokenRecord = (total, current, used = 11) => ({type: 'event_msg', payload: {
  type: 'token_count', info: {total_token_usage: {total_tokens: total}, last_token_usage: {total_tokens: current}, model_context_window: 100000},
  rate_limits: {primary: {used_percent: used, window_minutes: 10080}, secondary: null},
}})
fs.writeFileSync(transcript, jsonLine({type: 'session_meta', payload: {id: 'thread-a', private: 'PRIVATE metadata'}}) +
  jsonLine(tokenRecord(632156, 36000)) + jsonLine({type: 'response_item', payload: {text: 'PRIVATE answer'}}))
const managers = []
const completions = []
const payloads = []
const processEvents = []
const watchdog = setTimeout(() => {
  for (const sm of managers) sm.disposeAll()
  console.error('CODEX SMOKE TIMEOUT')
  process.exit(1)
}, 25000)

function run(exe, args, env, stdin = '') {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, {env, stdio: ['pipe', 'pipe', 'pipe']})
    let stdout = ''
    let stderr = ''
    p.stdout.on('data', (s) => { stdout += s })
    p.stderr.on('data', (s) => { stderr += s })
    p.on('error', reject)
    p.on('close', (code) => resolve({code, stdout, stderr}))
    p.stdin.on('error', () => {})
    p.stdin.end(stdin)
  })
}

let exitCode = 0
try {
  const port = await startHookServer({
    onState: (id, state, body) => managers.forEach((sm) => sm.setHookState(id, state, body)),
    onStatus: (id, body) => managers.map((sm) => sm.applyStatus(id, body)).find((x) => x !== null) ?? null,
    onCodex: (id, body) => {
      payloads.push(JSON.parse(body))
      managers.forEach((sm) => sm.setCodexHook(id, body))
    },
    onCodexExit: (id) => managers.forEach((sm) => sm.clearCodexSession(id)),
    onCodexProcess: (id, runId, event) => {
      processEvents.push({id, runId, event})
      managers.forEach((sm) => sm.setCodexProcess(id, runId, event))
    },
  })
  // /bin/sh は対話履歴を書かないので、実ユーザーの zsh 設定・履歴を汚さない。
  const previousShell = process.env.SHELL
  process.env.SHELL = '/bin/sh'
  let a, b
  try {
    managers.push(new SessionManager(port, 'wa'), new SessionManager(port, 'wb'))
    a = managers[0].create()
    b = managers[1].create()
  } finally {
    if (previousShell === undefined) delete process.env.SHELL
    else process.env.SHELL = previousShell
  }
  for (const sm of managers) sm.onResponseComplete = (info) => completions.push(info)
  const info = (id = a.id) => managers.flatMap((sm) => sm.currentUpdate().sessions).find((s) => s.id === id)
  const raw = (event, extra = {}) => ({hook_event_name: event, session_id: 'thread-a', turn_id: 'turn-1', model: 'test-model', transcript_path: transcript, ...extra})
  const emit = async (event, extra = {}, id = a.id) => {
    const result = await run('/bin/sh', ['-c', relayCommand], {
      ELECTRON_RUN_AS_NODE: '1', CLAUDE_TERM_CODEX: '1',
      CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: id,
      CLAUDE_TERM_EXECUTABLE: relayExecutable, CLAUDE_TERM_CODEX_RELAY: relayPath,
    }, JSON.stringify(raw(event, extra)))
    assert.deepEqual(result, {code: 0, stdout: '', stderr: ''}, '通知用hookは無出力・成功終了')
  }
  const post = (pathname) => new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path: pathname, method: 'POST'}, (res) => {
      res.resume()
      res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`HTTP ${res.statusCode}: ${pathname}`)))
    })
    req.on('error', reject)
    req.end()
  })
  const processNotice = (event, runId, id = a.id) => post(`/codex-process/${id}/${runId}/${event}`)
  await emit('SessionStart', {source: 'startup'})
  assert.equal(info().activeAgent, 'codex')
  assert.equal(info().state, 'idle')
  assert.equal(info().metrics.model, 'test-model')
  assert.deepEqual(info().metrics, {model: 'test-model', totalTokens: 632156, contextPct: 64,
    rateLimits: [{remainingPct: 89, windowMinutes: 10080}]})
  await emit('UserPromptSubmit', {prompt: 'PRIVATE PROMPT must not be relayed'})
  const now = Date.now
  try {
    Date.now = () => now() + 120000
    assert.equal(info().state, 'running', '2分無出力でもCodexは実行中')
  } finally { Date.now = now }
  await emit('SessionStart', {source: 'compact'})
  assert.equal(info().state, 'running', '自動compactで待機に戻さない')
  assert.equal(completions.length, 0)

  const tool = {tool_name: 'Bash', tool_input: {command: 'echo first', description: 'テストの実行を許可'}}
  await emit('PermissionRequest', tool)
  assert.equal(info().state, 'attention')
  assert.equal(info().attentionMessage, 'テストの実行を許可')
  await emit('PostToolUse', {tool_name: 'Bash', tool_input: {command: 'echo unrelated'}, tool_response: 'PRIVATE OUTPUT'})
  assert.equal(info().state, 'attention', '別のツール完了で承認待ちを解除しない')
  await emit('PermissionRequest', tool)
  await emit('PostToolUse', {tool_name: 'Bash', tool_input: {command: 'echo first'}})
  assert.equal(info().state, 'attention', '同じコマンドの承認が2件なら1件の完了では解除しない')
  await emit('PostToolUse', {tool_name: 'Bash', tool_input: {command: 'echo first'}})
  assert.equal(info().state, 'running')
  assert.equal(info().attentionMessage, null)
  await emit('Stop')
  await emit('Stop')
  assert.equal(info().state, 'idle')
  assert.deepEqual(completions.map((s) => [s.id, s.activeAgent]), [[a.id, 'codex']], '完了通知は一度だけ')
  await emit('PostToolUse', {agent_id: 'child', turn_id: 'child-turn', ...tool})
  await emit('PermissionRequest', {agent_id: 'child', turn_id: 'child-turn', ...tool})
  assert.equal(info().state, 'idle', '終了後に遅れた子エージェントイベントで復活しない')
  await emit('UserPromptSubmit', {turn_id: 'turn-2'})
  await emit('PermissionRequest', {agent_id: 'child', turn_id: 'child-turn', ...tool})
  assert.equal(info().state, 'attention', '処理中の子エージェント承認も表示する')
  await emit('PostToolUse', {agent_id: 'child', turn_id: 'child-turn', ...tool})
  assert.equal(info().state, 'running')
  await emit('Stop', {turn_id: 'turn-1'})
  assert.equal(info().state, 'running', '前のターンのStopで止めない')
  await emit('Interrupt', {turn_id: 'turn-2'})
  assert.equal(info().state, 'idle')
  assert.equal(completions.length, 1, '中断を応答完了として通知しない')
  await emit('PreToolUse', {turn_id: 'turn-2', ...tool})
  assert.equal(info().state, 'idle', '中断後の遅延イベントを無視する')
  console.log('ok   Codexの実行・承認・完了・中断・子エージェントと遅延イベント')

  managers[1].setHookState(b.id, 'idle')
  managers[1].setHookState(b.id, 'running')
  await emit('UserPromptSubmit', {turn_id: 'turn-3'})
  assert.equal(info(b.id).activeAgent, 'claude')
  assert.equal(info(b.id).state, 'running')
  managers[1].setHookState(b.id, 'attention', '{"message":"Claude approval"}')
  managers[1].setHookState(b.id, 'idle')
  assert.equal(completions.at(-1).activeAgent, 'claude')
  assert.equal(completions.at(-1).id, b.id)
  await emit('SessionEnd', {session_id: 'unrelated-thread'})
  assert.equal(info().state, 'running')
  assert.equal(managers[0].applyStatus(a.id, '{"model":{"display_name":"old-claude"}}'), null)
  managers[0].setHookState(a.id, 'clear')
  assert.equal(info().activeAgent, 'codex')
  const old = JSON.stringify(info())
  managers[0].setCodexHook(a.id, '{bad json')
  managers[0].setCodexHook(a.id, '{"event":"made-up","sessionId":"thread-a"}')
  assert.equal(JSON.stringify(info()), old)
  assert(!JSON.stringify(payloads).includes('PRIVATE'))
  assert(!JSON.stringify(payloads).includes(transcript), '記録のパスも転送しない')
  assert(!JSON.stringify(payloads).includes('echo first'), '承認の説明があればコマンド本文も転送しない')
  console.log('ok   ウィンドウ・プロバイダ・スレッドの分離と必要な情報だけの転送')

  const normalized = projectCodexEvent(raw('PermissionRequest', {turn_id: 'turn-3', ...tool}))
  const body = Buffer.from(JSON.stringify(normalized))
  const split = body.indexOf(Buffer.from('テスト')) + 1
  await new Promise((resolve, reject) => {
    const req = http.request({hostname: '127.0.0.1', port, path: `/codex/${a.id}`, method: 'POST'}, (res) => {
      res.resume()
      res.on('end', resolve)
    })
    req.on('error', reject)
    req.write(body.subarray(0, split))
    setImmediate(() => req.end(body.subarray(split)))
  })
  assert.equal(info().attentionMessage, 'テストの実行を許可', 'UTF-8分割受信でも日本語を保持する')

  const stub = path.join(tmp, 'codex')
  fs.writeFileSync(stub, `#!${process.execPath}\nif (process.env.CLAUDE_TERM_CODEX !== '1') process.exit(42); process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(17)\n`, {mode: 0o755})
  const launch = await run('/bin/sh', ['-c', `codex() { ${CODEX_FUNCTION_BODY}\n}; codex "$@"`, 'smoke', 'resume', 'thread with spaces', 'literal $(echo unsafe)'], {
    PATH: `${tmp}:${process.env.PATH}`, CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: a.id,
  })
  assert.equal(launch.code, 17, '起動元にはCodexの終了コードを返す')
  const args = JSON.parse(launch.stdout)
  assert.deepEqual(args, ['-c', `shell_environment_policy.set.CLAUDE_TERM_PORT="${port}"`, '-c', `shell_environment_policy.set.CLAUDE_TERM_SESSION="${a.id}"`,
    'resume', 'thread with spaces', 'literal $(echo unsafe)'])
  assert.equal(info().activeAgent, null, 'CLI異常終了でもCodex状態を解除する')
  assert.equal(info().metrics, null)
  assert.equal(info().attentionMessage, null)
  assert.equal(completions.length, 2, 'CLI終了を応答完了として通知しない')
  assert.equal(processEvents.length, 2)
  assert.equal(processEvents[0].event, 'start')
  assert.equal(processEvents[1].event, 'exit')
  assert.equal(processEvents[0].runId, processEvents[1].runId, '開始と終了は同じCLI呼出IDで対応付ける')
  const beforeNested = processEvents.length
  const nested = await run('/bin/sh', ['-c', `codex() { ${CODEX_FUNCTION_BODY}\n}; codex "$@"`, 'nested', '--version'], {
    PATH: `${tmp}:${process.env.PATH}`, CLAUDE_TERM_CODEX: '1', CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: a.id,
  })
  assert.deepEqual(nested, {code: 17, stdout: '["--version"]', stderr: ''})
  assert.equal(processEvents.length, beforeNested, 'ネストした呼出は開始・終了を重複通知しない')
  const unreachable = await run('/bin/sh', ['-c', `codex() { ${CODEX_FUNCTION_BODY}\n}; codex --version`], {
    PATH: `${tmp}:${process.env.PATH}`, CLAUDE_TERM_PORT: '1', CLAUDE_TERM_SESSION: a.id,
  })
  assert.equal(unreachable.code, 17, '存在通知に接続できなくてもCLIの終了コードを保持する')
  assert.equal(unreachable.stderr, '', '存在通知の失敗をCLI出力に混ぜない')
  assert.equal(JSON.parse(unreachable.stdout).at(-1), '--version')
  const noEnv = await run(process.execPath, [relayPath], {}, JSON.stringify(raw('Stop')))
  assert.deepEqual(noEnv, {code: 0, stdout: '', stderr: ''})
  const beforeGuard = payloads.length
  await run(process.execPath, [relayPath], {CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: a.id}, JSON.stringify(raw('UserPromptSubmit')))
  assert.equal(payloads.length, beforeGuard, '連携用関数を経由しないCodexは共有サーバー由来の通知先を使わない')
  console.log('ok   日本語通知・手入力時の引数保持・CLI異常終了・環境変数ガード')

  await emit('SessionStart', {source: 'startup'})
  for (const event of ['Stop', 'Interrupt']) {
    const turnId = `turn-without-${event}-id`
    await emit('UserPromptSubmit', {turn_id: turnId})
    assert.equal(info().state, 'running')
    const beforeCompletion = completions.length
    await emit(event, {turn_id: undefined})
    assert.equal(info().state, 'idle', `${event}: ターンIDがなくても待機へ戻す`)
    for (const toolEvent of ['PreToolUse', 'PostToolUse']) {
      await emit(toolEvent, {turn_id: turnId, ...tool})
      assert.equal(info().state, 'idle', `${event}: ID欠損の終了後に遅れた${toolEvent}で実行中へ戻さない`)
    }
    assert.equal(completions.length, beforeCompletion + Number(event === 'Stop'),
      `${event}: ID欠損時もStopだけ一度完了通知する`)
  }
  console.log('ok   ターンIDが欠けた完了・中断後の遅延ツールイベント')

  // hook を発火しない本物の子プロセスを起動し、実行中の状態を確認してから解放する。
  fs.writeFileSync(stub, `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(process.env.STUB_READY, 'ready'); process.stdout.write(JSON.stringify(process.argv.slice(2))); setInterval(() => { if (fs.existsSync(process.env.STUB_RELEASE)) process.exit(17) }, 10); setTimeout(() => process.exit(97), 5000).unref()\n`, {mode: 0o755})
  let previousRunId = processEvents[0].runId
  for (const mode of ['no-hooks', 'with-hooks']) {
    const ready = path.join(tmp, `${mode}.ready`)
    const release = path.join(tmp, `${mode}.release`)
    const beforeEvents = processEvents.length
    const beforeCompletion = completions.length
    const otherSession = JSON.stringify(info(b.id))
    const invocation = run('/bin/sh', ['-c', `set -eu; codex() { ${CODEX_FUNCTION_BODY}\n}; codex resume "thread with spaces"`], {
      PATH: `${tmp}:${process.env.PATH}`, CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: a.id,
      STUB_READY: ready, STUB_RELEASE: release,
    })
    let outcome
    try {
      const deadline = Date.now() + 3000
      while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      assert(fs.existsSync(ready), 'CLI stub が起動する')
      const start = processEvents.slice(beforeEvents).find((entry) => entry.event === 'start')
      assert(start?.runId && start.runId !== previousRunId, 'CLI呼出ごとに存在通知IDを変える')
      assert.equal(info().activeAgent, 'codex', 'hookを信頼する前も起動中のCodexを表示する')
      assert.equal(info().state, 'unknown', 'CLIの存在だけで実行中・待機を決めない')
      assert.equal(info().metrics, null, 'モデルや使用量を作らず、前回の値も持ち越さない')
      assert.equal(info().attentionMessage, null)
      assert.equal(JSON.stringify(info(b.id)), otherSession, '別ウィンドウのセッションに存在通知を混ぜない')
      managers[0].setHookState(a.id, 'idle')
      assert.equal(info().activeAgent, 'codex', '追跡中のCLIを遅れたClaude hookで上書きしない')
      assert.equal(managers[0].applyStatus(a.id, '{"model":{"display_name":"old-claude"}}'), null)
      await processNotice('exit', previousRunId)
      await post(`/codex-exit/${a.id}`)
      assert.equal(info().state, 'unknown', '古い呼出やIDのない旧wrapperの終了で現在のCLIを消さない')
      await processNotice('exit', start.runId, b.id)
      assert.equal(JSON.stringify(info(b.id)), otherSession, '他セッション宛の終了は無視する')

      if (mode === 'with-hooks') {
        await emit('SessionStart', {source: 'startup'})
        assert.equal(info().state, 'idle', '本物のhookで待機を判定する')
        assert.equal(info().metrics.model, 'test-model')
        await emit('UserPromptSubmit', {turn_id: 'presence-turn'})
        await processNotice('start', start.runId)
        assert.equal(info().state, 'running', '同じ存在通知の再送で取得済みの実行状態を消さない')
        assert.equal(info().metrics.model, 'test-model')
        await emit('Stop', {turn_id: 'presence-turn'})
        assert.equal(info().state, 'idle')
        await emit('SessionEnd')
        assert.equal(info().activeAgent, 'codex', 'スレッド終了後もCLIが存在する間は提供元を保持する')
        assert.equal(info().state, 'unknown')
        assert.equal(info().metrics, null)
        await emit('SessionStart', {source: 'resume', session_id: 'next-thread', model: 'next-model'})
        await emit('SessionEnd', {session_id: 'thread-a'})
        assert.equal(info().state, 'idle', '前のスレッドの終了で新しいスレッドを消さない')
        assert.equal(info().metrics.model, 'next-model')
      } else {
        await emit('SessionEnd')
        assert.equal(info().state, 'unknown', '未接続スレッドの終了からCLI終了を推測しない')
      }
      previousRunId = start.runId
    } finally {
      fs.writeFileSync(release, 'release')
      outcome = await invocation
    }
    assert.equal(outcome.code, 17, 'hookの有無にかかわらずCLIの終了コードを保持する')
    assert.equal(outcome.stderr, '')
    assert.deepEqual(JSON.parse(outcome.stdout), ['-c', `shell_environment_policy.set.CLAUDE_TERM_PORT="${port}"`,
      '-c', `shell_environment_policy.set.CLAUDE_TERM_SESSION="${a.id}"`, 'resume', 'thread with spaces'])
    assert.equal(processEvents.at(-1).runId, previousRunId)
    assert.equal(processEvents.at(-1).event, 'exit')
    assert.equal(info().activeAgent, null, 'hookなしでも対応するCLI終了で提供元を解除する')
    assert.equal(info().state, 'idle')
    assert.equal(info().metrics, null)
    assert.equal(info().attentionMessage, null)
    assert.equal(completions.length, beforeCompletion + Number(mode === 'with-hooks'), '存在通知やCLI終了は応答完了として通知しない')
  }
  await emit('SessionStart', {source: 'startup'})
  await emit('UserPromptSubmit', {turn_id: 'legacy-exit-turn'})
  const beforeLegacyExit = completions.length
  await post(`/codex-exit/${a.id}`)
  await emit('PreToolUse', {turn_id: 'legacy-exit-turn', ...tool})
  assert.equal(info().activeAgent, null, '旧wrapperの終了経路も保持し、遅延hookで再開しない')
  assert.equal(completions.length, beforeLegacyExit)
  console.log('ok   hook未信頼時のCLI存在・未知状態・終了の対応付け・hook復帰・旧wrapper互換')

  // 実際のログインシェルで codex / alias を入力し、設定ファイルと通知先の継承を検証。
  const zshRoot = path.join(tmp, 'zsh config')
  const zshNext = path.join(tmp, 'changed zsh config')
  fs.mkdirSync(zshRoot)
  fs.mkdirSync(zshNext)
  fs.writeFileSync(path.join(zshRoot, '.zshenv'), `export CLAUDE_TERM_RC_TRACE=env\nexport ZDOTDIR=${quote(zshNext)}\n`)
  fs.writeFileSync(path.join(zshNext, '.zprofile'), 'export CLAUDE_TERM_RC_TRACE="$CLAUDE_TERM_RC_TRACE,profile"\n')
  fs.writeFileSync(path.join(zshNext, '.zshrc'), `unset HISTFILE\nexport PATH=${quote(tmp)}:"$PATH"\nexport CLAUDE_TERM_RC_TRACE="$CLAUDE_TERM_RC_TRACE,rc"\nalias cx='codex resume'\n`)
  fs.writeFileSync(path.join(zshNext, '.zlogin'), 'export CLAUDE_TERM_RC_TRACE="$CLAUDE_TERM_RC_TRACE,login"\n')
  fs.writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({args:process.argv.slice(2), flag:process.env.CLAUDE_TERM_CODEX, zdotdir:process.env.ZDOTDIR, trace:process.env.CLAUDE_TERM_RC_TRACE})); process.exit(17)\n`, {mode: 0o755})
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    const env = {PATH: `${tmp}:${process.env.PATH}`, CLAUDE_TERM_PORT: String(port), CLAUDE_TERM_SESSION: b.id, ZDOTDIR: zshRoot}
    configureShellIntegration(shell, env)
    const flags = shell.endsWith('zsh') ? ['-lic', 'set -eu; cx "thread with spaces"'] : ['--noprofile', '--norc', '-lic', 'set -eu; codex resume "thread with spaces"']
    const result = await run(shell, flags, env)
    assert.equal(result.code, 17, `${shell}: 終了コードを保持`)
    const invocation = JSON.parse(result.stdout)
    assert.equal(invocation.flag, '1')
    assert.deepEqual(invocation.args, ['-c', `shell_environment_policy.set.CLAUDE_TERM_PORT="${port}"`, '-c', `shell_environment_policy.set.CLAUDE_TERM_SESSION="${b.id}"`, 'resume', 'thread with spaces'])
    if (shell.endsWith('zsh')) {
      assert.equal(invocation.trace, 'env,profile,rc,login')
      assert.equal(invocation.zdotdir, zshNext)
    }
  }
  console.log('ok   zsh/bash の通常起動・alias・ユーザー設定の読込順・ZDOTDIR の変更と復元')

  assert.equal(readCodexUsage(transcript, 'another-thread'), null, '別スレッドの使用量を混ぜない')
  const symlink = path.join(tmp, 'symlink.jsonl')
  fs.symlinkSync(transcript, symlink)
  assert.equal(readCodexUsage(symlink, 'thread-a'), null)
  fs.appendFileSync(transcript, jsonLine({type: 'response_item', payload: {text: 'PRIVATE'.repeat(400000)}}) +
    jsonLine(tokenRecord(710000, 12000)) + '{"type":"event_msg"')
  assert.deepEqual(readCodexUsage(transcript, 'thread-a'), {totalTokens: 710000, contextPct: 88,
    rateLimits: [{remainingPct: 89, windowMinutes: 10080}]}, '巨大な出力・書込み中の最終行を無視し、圧縮後は直近の量で残量を計算')
  fs.appendFileSync(transcript, '\n' + jsonLine({type: 'event_msg', payload: {type: 'token_count', info: null,
    rate_limits: {primary: {used_percent: 35, window_minutes: 300}, secondary: null}}}))
  assert.deepEqual(readCodexUsage(transcript, 'thread-a'), {totalTokens: 710000, contextPct: 88,
    rateLimits: [{remainingPct: 65, windowMinutes: 300}]}, '利用上限だけの更新でもトークン数を保持')
  assert.equal(parseCodexUsage({totalTokens: -1, contextPct: 101, costUsd: 500}), null)
  assert.deepEqual(parseCodexUsage({totalTokens: 0, contextPct: 0}), {totalTokens: 0, contextPct: 0})
  assert.equal(readCodexUsage(path.join(tmp, 'missing.jsonl'), 'thread-a'), null)
  console.log('ok   トークン数・コンテキスト残量・利用上限・巨大ログ・不完全行・セッション分離')
  console.log('CODEX SMOKE PASS')
} catch (error) {
  exitCode = 1
  console.error(error)
} finally {
  for (const sm of managers) sm.disposeAll()
  await whenAllPtysExited(1500)
  clearTimeout(watchdog)
  fs.rmSync(tmp, {recursive: true, force: true})
}
process.exit(exitCode)
