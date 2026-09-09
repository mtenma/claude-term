// 一時ディレクトリと Electron のモックだけで、同意と設定ファイルの保存を検証する。
import * as esbuild from 'esbuild'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import * as fs from 'node:fs'
import {createRequire} from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
await esbuild.build({
  absWorkingDir: root,
  entryPoints: ['src/main/codexHooks.ts', 'src/main/claudeHooks.ts'],
  outdir: 'dist-test/hook-installers',
  outExtension: {'.js': '.cjs'},
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'silent',
})
const compiled = Object.fromEntries(['codexHooks', 'claudeHooks'].map((name) =>
  [name, fs.readFileSync(path.join(root, 'dist-test/hook-installers', `${name}.cjs`), 'utf8')],
))
const fixtureRoots = []
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), {recursive: true})
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}
const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))

function fixture(customHome = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-term-hook-installers-'))
  fixtureRoots.push(directory)
  const home = path.join(directory, 'home')
  const userData = path.join(directory, 'userData')
  const codexHome = customHome ? path.join(directory, 'custom codex home') : path.join(home, '.codex')
  const mainDirectory = path.join(directory, "App's $(false).app", 'Contents/Resources/app.asar/dist/main')
  const executable = path.join(directory, "Electron's $(false)")
  const state = {
    directory, home, userData, codexHome, executable, mainDirectory,
    consentPath: path.join(userData, 'config.json'),
    hooksPath: path.join(codexHome, 'hooks.json'),
    claudePath: path.join(home, '.claude/settings.json'),
    dialogs: [], mutations: [], responses: [], fail: null, onQuestion: null,
  }
  const mockFs = {...fs}
  for (const method of ['writeFileSync', 'renameSync', 'mkdirSync', 'chmodSync', 'unlinkSync']) {
    mockFs[method] = (...args) => {
      state.mutations.push([method, ...args])
      if (state.fail?.(method, args)) throw Object.assign(new Error('Simulated I/O failure'), {code: 'EACCES'})
      return fs[method](...args)
    }
  }
  const electron = {
    app: {getPath: (name) => {
      assert.equal(name, 'userData')
      return userData
    }},
    dialog: {showMessageBox: async (_win, options) => {
      state.dialogs.push(options)
      if (options.type === 'question') {
        await state.onQuestion?.()
        return {response: state.responses.shift() ?? 0}
      }
      return {response: 0}
    }},
  }
  const mockProcess = {env: customHome ? {CODEX_HOME: codexHome} : {}, execPath: executable}
  state.process = mockProcess
  for (const [name, source] of Object.entries(compiled)) {
    const module = {exports: {}}
    vm.runInNewContext(source, {
      module, exports: module.exports,
      require: (specifier) => {
        if (specifier === 'electron') return electron
        if (specifier === 'node:fs') return mockFs
        if (specifier === 'node:os') return {...os, homedir: () => home}
        return require(specifier)
      },
      __dirname: mainDirectory,
      process: mockProcess,
      structuredClone,
      console: {log: () => {}, warn: () => {}},
    }, {filename: `${name}.cjs`})
    Object.assign(state, module.exports)
  }
  state.window = {isDestroyed: () => false}
  return state
}

try {
  const t = fixture()
  const original = '{\n  "description": "keep",\n  "hooks": {"PreCompact": [{"hooks": [{"type": "command", "command": "echo mine"}]}]}\n}\n'
  fs.mkdirSync(t.codexHome, {recursive: true})
  fs.writeFileSync(t.hooksPath, original)
  writeJson(t.consentPath, {hooksConsent: 'granted', metadata: {keep: true}})
  const protectedFiles = ['config.toml', 'auth.json', 'hook-trust.json']
  for (const name of protectedFiles) fs.writeFileSync(path.join(t.codexHome, name), `preserve ${name}`)
  await t.ensureCodexHooks(t.window)
  const installed = readJson(t.hooksPath)
  assert.equal(installed.description, 'keep')
  assert.deepEqual(installed.hooks.PreCompact, JSON.parse(original).hooks.PreCompact)
  assert.equal(fs.readFileSync(`${t.hooksPath}.backup-claude-term`, 'utf8'), original)
  assert.deepEqual(readJson(t.consentPath), {
    hooksConsent: 'granted', metadata: {keep: true}, codexHooksConsent: 'granted',
  })
  assert.equal(t.dialogs.length, 1)
  for (const text of [t.hooksPath, `${t.hooksPath}.backup-claude-term`, '/hooks']) {
    assert.ok(t.dialogs[0].detail.includes(text))
  }
  for (const name of protectedFiles) {
    assert.equal(fs.readFileSync(path.join(t.codexHome, name), 'utf8'), `preserve ${name}`)
  }
  const afterInstall = fs.readFileSync(t.hooksPath, 'utf8')
  const mutations = t.mutations.length
  await t.ensureCodexHooks(t.window)
  assert.equal(fs.readFileSync(t.hooksPath, 'utf8'), afterInstall)
  assert.equal(t.dialogs.length, 1)
  assert.equal(t.mutations.length, mutations)
  console.log('ok   Codex の既存設定・同意・バックアップを保持し、再適用は無変更')

  // 開発版/配布版の実行ファイルが変わっても、Codex が信頼する定義は同一に保つ。
  t.process.execPath = path.join(t.directory, 'Another Electron')
  await t.ensureCodexHooks(t.window)
  assert.equal(fs.readFileSync(t.hooksPath, 'utf8'), afterInstall)
  assert.equal(t.mutations.length, mutations)
  console.log('ok   アプリの実行パスが変わっても Codex hook 定義を書き換えない')

  // パスに空白・引用符・コマンド置換文字があっても、文字列として渡される。
  fs.writeFileSync(t.executable, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$@" > "$CLAUDE_TERM_TEST_RECORD"\ncat >> "$CLAUDE_TERM_TEST_RECORD"\n', {mode: 0o755})
  const recordPath = path.join(t.directory, 'relay-record.txt')
  const command = installed.hooks.PermissionRequest[0].hooks[0].command
  const env = {PATH: process.env.PATH, CLAUDE_TERM_TEST_RECORD: recordPath}
  const destinationEnv = {...env, CLAUDE_TERM_PORT: '1234', CLAUDE_TERM_SESSION: 'test-session'}
  const runtimeEnv = {...destinationEnv,
    CLAUDE_TERM_EXECUTABLE: t.executable,
    CLAUDE_TERM_CODEX_RELAY: path.join(t.mainDirectory, 'codexHookRelay.js'),
  }
  for (const incompleteEnv of [
    env,
    {...env, CLAUDE_TERM_CODEX: '1', CLAUDE_TERM_PORT: '1234'},
    {...env, CLAUDE_TERM_CODEX: '1', CLAUDE_TERM_SESSION: 'test-session'},
    destinationEnv,
    {...destinationEnv, CLAUDE_TERM_CODEX: '0'},
    {...destinationEnv, CLAUDE_TERM_CODEX: '1'},
    {...runtimeEnv, CLAUDE_TERM_CODEX: '1', CLAUDE_TERM_EXECUTABLE: ''},
    {...runtimeEnv, CLAUDE_TERM_CODEX: '1', CLAUDE_TERM_CODEX_RELAY: ''},
  ]) {
    const result = spawnSync('/bin/sh', ['-c', command], {env: incompleteEnv, input: 'skip', encoding: 'utf8'})
    assert.equal(result.status, 0)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(fs.existsSync(recordPath), false)
  }
  const relayed = spawnSync('/bin/sh', ['-c', command], {
    env: {...runtimeEnv, CLAUDE_TERM_CODEX: '1'},
    input: '{"hook_event_name":"PermissionRequest"}', encoding: 'utf8',
  })
  assert.equal(relayed.status, 0)
  assert.equal(relayed.stdout, '')
  assert.equal(relayed.stderr, '')
  assert.equal(fs.readFileSync(recordPath, 'utf8'),
    `1\n${path.join(t.mainDirectory, 'codexHookRelay.js')}\n{"hook_event_name":"PermissionRequest"}`)
  console.log('ok   Electron・app.asar のパスを正しく引用し、連携フラグと通知先が揃った場合だけ stdin を転送')

  // 同一の定義でも、起動元セッションが渡した別のアプリとrelayを選べる。
  fs.copyFileSync(t.executable, t.process.execPath)
  fs.chmodSync(t.process.execPath, 0o755)
  const alternateRelay = path.join(t.directory, 'Development build/codexHookRelay.js')
  const alternate = spawnSync('/bin/sh', ['-c', command], {
    env: {...runtimeEnv, CLAUDE_TERM_CODEX: '1',
      CLAUDE_TERM_EXECUTABLE: t.process.execPath, CLAUDE_TERM_CODEX_RELAY: alternateRelay},
    input: 'alternate', encoding: 'utf8',
  })
  assert.equal(alternate.status, 0)
  assert.equal(alternate.stdout, '')
  assert.equal(alternate.stderr, '')
  assert.equal(fs.readFileSync(recordPath, 'utf8'), `1\n${alternateRelay}\nalternate`)
  console.log('ok   同じ hook 定義から起動元アプリの通知スクリプトを使う')

  const fallback = fixture(false)
  fallback.responses.push(0)
  await fallback.ensureCodexHooks(fallback.window)
  assert.ok(fs.existsSync(path.join(fallback.home, '.codex/hooks.json')))
  assert.equal(fs.existsSync(`${fallback.hooksPath}.backup-claude-term`), false)
  console.log('ok   CODEX_HOME が未設定ならホーム内の .codex を利用')

  for (const installer of ['codex', 'claude']) {
    const declined = fixture()
    const ownKey = installer === 'codex' ? 'codexHooksConsent' : 'hooksConsent'
    const otherKey = installer === 'codex' ? 'hooksConsent' : 'codexHooksConsent'
    writeJson(declined.consentPath, {[otherKey]: 'granted', metadata: {keep: true}})
    declined.responses.push(1)
    const ensure = installer === 'codex' ? declined.ensureCodexHooks : declined.ensureClaudeHooks
    await ensure(declined.window)
    assert.deepEqual(readJson(declined.consentPath), {
      [otherKey]: 'granted', metadata: {keep: true}, [ownKey]: 'denied',
    })
    assert.equal(fs.existsSync(declined.hooksPath), false)
    assert.equal(fs.existsSync(declined.claudePath), false)
    const writes = declined.mutations.length
    await ensure(declined.window)
    assert.equal(declined.dialogs.length, 1)
    assert.equal(declined.mutations.length, writes)

    const granted = fixture()
    writeJson(granted.consentPath, {[otherKey]: 'denied', metadata: {keep: true}})
    granted.onQuestion = () => writeJson(granted.consentPath, {
      [otherKey]: 'granted', metadata: {keep: true}, updatedDuringDialog: true,
    })
    await (installer === 'codex' ? granted.ensureCodexHooks : granted.ensureClaudeHooks)(granted.window)
    assert.deepEqual(readJson(granted.consentPath), {
      [otherKey]: 'granted', metadata: {keep: true}, updatedDuringDialog: true, [ownKey]: 'granted',
    })
    assert.ok(fs.existsSync(installer === 'codex' ? granted.hooksPath : granted.claudePath))
  }
  console.log('ok   両 installer とも他方の同意とダイアログ中の変更を保持し、拒否後は再質問しない')

  for (const invalid of ['{invalid', 'null', '[]', '"invalid"']) {
    for (const installer of ['codex', 'claude']) {
      const broken = fixture()
      fs.mkdirSync(broken.userData, {recursive: true})
      fs.writeFileSync(broken.consentPath, invalid)
      await (installer === 'codex' ? broken.ensureCodexHooks : broken.ensureClaudeHooks)(broken.window)
      assert.equal(fs.readFileSync(broken.consentPath, 'utf8'), invalid)
      assert.equal(broken.mutations.length, 0)
      assert.equal(broken.dialogs.filter((item) => item.type === 'question').length, 0)
    }
  }
  console.log('ok   両 installer とも破損した同意ファイルを上書きせず、何も保存しない')

  for (const invalid of ['{invalid', 'null', '[]', '{"hooks":{"Stop":{}}}']) {
    const broken = fixture()
    fs.mkdirSync(broken.codexHome, {recursive: true})
    fs.writeFileSync(broken.hooksPath, invalid)
    await broken.ensureCodexHooks(broken.window)
    assert.equal(fs.readFileSync(broken.hooksPath, 'utf8'), invalid)
    assert.equal(broken.mutations.length, 0)
    assert.equal(broken.dialogs.length, 1)
    assert.equal(broken.dialogs[0].type, 'warning')
  }
  console.log('ok   壊れた Codex hooks は警告だけ表示し、同意記録と設定の更新を行わない')

  const edited = fixture()
  writeJson(edited.hooksPath, {})
  edited.onQuestion = () => writeJson(edited.hooksPath, {description: 'changed while asking'})
  await edited.ensureCodexHooks(edited.window)
  assert.equal(readJson(edited.hooksPath).description, 'changed while asking')
  assert.equal(readJson(`${edited.hooksPath}.backup-claude-term`).description, 'changed while asking')

  for (const installer of ['codex', 'claude']) {
    const brokenDuringDialog = fixture()
    writeJson(brokenDuringDialog.consentPath, {})
    brokenDuringDialog.onQuestion = () => fs.writeFileSync(brokenDuringDialog.consentPath, '{invalid')
    await (installer === 'codex' ? brokenDuringDialog.ensureCodexHooks : brokenDuringDialog.ensureClaudeHooks)(brokenDuringDialog.window)
    assert.equal(brokenDuringDialog.mutations.length, 0)
    assert.equal(fs.readFileSync(brokenDuringDialog.consentPath, 'utf8'), '{invalid')
  }
  console.log('ok   同意ダイアログ後も hooks と同意ファイルを再確認する')

  for (const target of ['backup', 'hooks', 'consent']) {
    const failed = fixture()
    writeJson(failed.hooksPath, {description: 'before failure'})
    writeJson(failed.consentPath, {hooksConsent: 'denied'})
    const before = fs.readFileSync(failed.hooksPath, 'utf8')
    failed.fail = (method, args) => method === 'renameSync' && args[1] ===
      (target === 'backup' ? `${failed.hooksPath}.backup-claude-term` : target === 'hooks' ? failed.hooksPath : failed.consentPath)
    await failed.ensureCodexHooks(failed.window)
    assert.deepEqual(readJson(failed.consentPath), {hooksConsent: 'denied'})
    assert.equal(failed.dialogs.at(-1).type, 'warning')
    if (target !== 'consent') assert.equal(fs.readFileSync(failed.hooksPath, 'utf8'), before)
    if (target !== 'backup') assert.equal(fs.readFileSync(`${failed.hooksPath}.backup-claude-term`, 'utf8'), before)
    assert.equal(fs.readdirSync(failed.codexHome).some((name) => name.includes('.tmp-')), false)
    assert.equal(fs.readdirSync(failed.userData).some((name) => name.includes('.tmp-')), false)
    failed.fail = null
    await failed.ensureCodexHooks(failed.window)
    assert.equal(readJson(failed.consentPath).codexHooksConsent, 'granted')
    assert.equal(failed.dialogs.filter((item) => item.type === 'question').length, 2)
  }
  console.log('ok   バックアップ・設定・同意の保存失敗でも呼び出し元を止めず、次回再試行できる')

  const upgrade = fixture()
  writeJson(upgrade.consentPath, {codexHooksConsent: 'granted', hooksConsent: 'denied'})
  writeJson(upgrade.hooksPath, {hooks: {Stop: [{hooks: [
    {type: 'command', command: 'old-relay # claude-term-codex-hook'},
  ]}]}})
  await upgrade.ensureCodexHooks(upgrade.window)
  assert.equal(upgrade.dialogs.length, 0)
  assert.equal(readJson(upgrade.hooksPath).hooks.Stop.length, 1)
  assert.ok(readJson(upgrade.hooksPath).hooks.Stop[0].hooks[0].command.includes('ELECTRON_RUN_AS_NODE=1'))
  console.log('ok   同意済みの Codex hooks は再質問せず最新版に更新')
  console.log('HOOK INSTALLERS SMOKE PASS')
} finally {
  for (const directory of fixtureRoots) fs.rmSync(directory, {recursive: true, force: true})
}
