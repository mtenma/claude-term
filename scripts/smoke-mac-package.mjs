import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {readdirSync} from 'node:fs'
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
const sourceApp = path.resolve('node_modules/electron/dist/Electron.app')
const originalUuid = uuid(path.join(sourceApp, 'Contents/MacOS/Electron'))
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
console.log(`macOS package OK: signed app and ${bundles.length - 1} helpers, distinct UUIDs, LAN usage descriptions, packaged PTY`)
