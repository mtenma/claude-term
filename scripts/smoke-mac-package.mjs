import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, readdirSync, rmSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'

const app = path.resolve(process.argv[2] ?? 'release/mac-arm64/Claude Term.app')
function readPlist(file) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {encoding: 'utf8'}))
}
function uuid(file) {
  const output = execFileSync('/usr/bin/dwarfdump', ['--uuid', file], {encoding: 'utf8'})
  const match = /^UUID: ([A-F0-9-]+)/m.exec(output)
  assert.ok(match, `Missing executable UUID: ${file}`)
  return match[1]
}

execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {stdio: 'pipe'})
// Electron 43 は本体をインストールの時ではなく、初めて場所を聞かれたときにダウンロードする
// (新しい npm は依存の install スクリプトも止める)。require('electron') で場所を聞き、無ければ取らせる
const originalUuid = uuid(createRequire(import.meta.url)('electron'))
const mainInfo = readPlist(path.join(app, 'Contents/Info.plist'))
assert.equal(mainInfo.CFBundleIdentifier, 'jp.sabira.claude-term')
assert.ok(mainInfo.NSLocalNetworkUsageDescription)
const frameworks = path.join(app, 'Contents/Frameworks')
const bundles = [app, ...readdirSync(frameworks)
  .filter((name) => name.endsWith('.app'))
  .map((name) => path.join(frameworks, name))]
const uuids = new Set()
for (const bundle of bundles) {
  const info = readPlist(path.join(bundle, 'Contents/Info.plist'))
  assert.equal(info.NSLocalNetworkUsageDescription, mainInfo.NSLocalNetworkUsageDescription)
  const signature = spawnSync('/usr/bin/codesign', ['-dv', bundle], {encoding: 'utf8'})
  assert.equal(signature.status, 0, signature.stderr)
  assert.ok(signature.stderr.split('\n').includes(`Identifier=${info.CFBundleIdentifier}`), signature.stderr)
  const bundleUuid = uuid(path.join(bundle, 'Contents/MacOS', info.CFBundleExecutable))
  assert.notEqual(bundleUuid, originalUuid, `Electron UUID was retained: ${bundle}`)
  assert.ok(!uuids.has(bundleUuid), `Shared executable UUID: ${bundle}`)
  uuids.add(bundleUuid)
}
// 署名変更で Electron のロードや native addon の実行が壊れていないことも確認する。
const ptyModule = path.join(app, 'Contents/Resources/app.asar/node_modules/node-pty')
const runtime = spawnSync(path.join(app, 'Contents/MacOS', mainInfo.CFBundleExecutable), ['-e', `
  const pty = require(${JSON.stringify(ptyModule)}).spawn('/bin/sh', ['-c', 'printf CLAUDE_TERM_PACKAGED_PTY_OK'], {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: '/private/tmp', env: {PATH: '/usr/bin:/bin'},
  })
  let output = ''
  pty.onData((data) => { output += data })
  pty.onExit(({exitCode}) => {
    process.stdout.write(output)
    process.exitCode = exitCode
  })
`], {encoding: 'utf8', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, timeout: 10000})
assert.equal(runtime.status, 0, `Packaged runtime failed: ${runtime.error ?? runtime.stderr}`)
assert.equal(runtime.stdout, 'CLAUDE_TERM_PACKAGED_PTY_OK')

// コスト画面: asar 内の utilityProcess と node:sqlite で、偽の記録の取込みと表示の検証が通ること。
// 偽の記録・DB・撮影画像はプロジェクト内の dist-test に作り、実ユーザーの集計データには触れない
mkdirSync('dist-test', {recursive: true})
const costDir = mkdtempSync(path.resolve('dist-test', 'package-cost-'))
const cost = spawnSync(path.join(app, 'Contents/MacOS', mainInfo.CFBundleExecutable), [], {
  encoding: 'utf8',
  timeout: 60000,
  env: {
    ...process.env, TZ: 'Asia/Tokyo', CLAUDE_TERM_DEMO: 'cost', CLAUDE_TERM_SHOT_DELAY: '10000',
    CLAUDE_TERM_SCREENSHOT: path.join(costDir, 'cost.png'), CLAUDE_TERM_USAGE_FIXTURE_DIR: costDir,
  },
})
rmSync(costDir, {recursive: true, force: true})
assert.equal(cost.status, 0, `Packaged cost window failed: ${cost.error ?? cost.stderr}`)

// 更新のお知らせの窓: asar の中の画面・preload が読み込め、偽の更新情報で表示と操作の検証が通ること(通信と入れ替えはしない)
const updateDir = mkdtempSync(path.resolve('dist-test', 'package-update-'))
const update = spawnSync(path.join(app, 'Contents/MacOS', mainInfo.CFBundleExecutable), [], {
  encoding: 'utf8',
  timeout: 60000,
  env: {...process.env, CLAUDE_TERM_DEMO: 'update-busy', CLAUDE_TERM_SHOT_DELAY: '6000',
    CLAUDE_TERM_SCREENSHOT: path.join(updateDir, 'update.png')},
})
rmSync(updateDir, {recursive: true, force: true})
assert.equal(update.status, 0, `Packaged update window failed: ${update.error ?? update.stderr}`)
console.log(`macOS package OK: signed app and ${bundles.length - 1} helpers, distinct UUIDs, LAN usage descriptions, packaged PTY, cost window, update window`)
