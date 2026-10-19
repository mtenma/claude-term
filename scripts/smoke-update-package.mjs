// アプリの更新を、実際のパッケージで最後まで通す検査(手で流す。数分かかる)。
//   版 0.0.1(A)と 0.0.2(B)を検査用の bundle ID で作り、A を dist-test の中から起動する。
//   ローカルの HTTP サーバ(127.0.0.1)で B を配る → A がお知らせを出して自動で［今すぐ更新］→ ダウンロード・確かめ・展開
//   → A が終了し、終了の直前に入れ替える → B が起動し、前回の更新の成否を書いて終わる。
// 検査用の版は userData を dist-test に分け、hooks の確認をしない。/Applications のアプリ、普段の userData、
// ~/.claude・~/.codex には触れない(前後で更新時刻と SHA-256 を比べる)。画面に窓が一瞬出る
import assert from 'node:assert/strict'
import {execFileSync, spawn} from 'node:child_process'
import {createHash, generateKeyPairSync, sign} from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'
import {TEST_MARKER, signedMessage, zipName} from './release.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, 'dist-test', `update-pkg-${process.pid}`)
const rel = (file) => path.relative(root, file)
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const TEST_ID = 'jp.sabira.claude-term.update-test'
const PRODUCT = 'Claude Term Update Test'
const APP_NAME = `${PRODUCT}.app`
const OLD = '0.0.1'
const NEW = '0.0.2'

fs.rmSync(work, {recursive: true, force: true})
fs.mkdirSync(work, {recursive: true})
let server
process.on('exit', () => {
  server?.close()
  try {
    // 検査用の A・B が残っていれば止める
    execFileSync('/usr/bin/pkill', ['-f', work], {stdio: 'ignore'})
  } catch {
    // 残っていなければよい
  }
  // 作った .app は(起動しなくても)LaunchServices に登録される。展開の途中だけ現れたパスや、入れ替えで動かした
  // 元の場所の登録も残るので、登録の一覧から dist-test の下のものを探して外す
  unregisterUnder(work)
  // 検査用の版を起動すると、macOS がその bundle ID の設定ファイルを ~/Library/Preferences に作る
  try {
    execFileSync('/usr/bin/defaults', ['delete', TEST_ID], {stdio: 'ignore'})
  } catch {
    // 無ければよい
  }
  // defaults delete の後も、空のファイルが残る
  fs.rmSync(path.join(os.homedir(), 'Library/Preferences', `${TEST_ID}.plist`), {force: true})
  fs.rmSync(work, {recursive: true, force: true})
})

function unregisterUnder(dir) {
  let dump = ''
  try {
    dump = execFileSync(LSREGISTER, ['-dump'], {encoding: 'utf8', maxBuffer: 512 << 20, stdio: ['ignore', 'pipe', 'ignore']})
  } catch {
    return
  }
  for (const line of dump.split('\n')) {
    const match = /^path:\s+(.*?)(?: \(0x[0-9a-f]+\))?$/.exec(line)
    if (!match || !match[1].startsWith(dir + path.sep)) continue
    try {
      execFileSync(LSREGISTER, ['-u', match[1]], {stdio: 'ignore'})
    } catch {
      // 片付けの失敗で結果を変えない
    }
  }
}

// 本物の設定に触れていないことを、前後で比べる(読むだけ)
const watched = [path.join(os.homedir(), '.claude/settings.json'), path.join(os.homedir(), '.codex/hooks.json')]
const fingerprint = () => watched.map((file) => {
  try {
    return `${fs.statSync(file).mtimeMs}:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`
  } catch {
    return 'missing'
  }
})
const before = fingerprint()

// ---- 鍵と配る場所 ----
const {privateKey} = generateKeyPairSync('ed25519')
const pub = Buffer.from(privateKey.export({format: 'jwk'}).x, 'base64url').toString('base64')
const serve = path.join(work, 'serve')
fs.mkdirSync(serve)
const port = await new Promise((resolve) => {
  server = http.createServer((req, res) => {
    const file = path.join(serve, decodeURIComponent(new URL(req.url, 'http://x').pathname))
    if (!file.startsWith(serve + path.sep) || !fs.existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, {'content-length': fs.statSync(file).size})
    fs.createReadStream(file).pipe(res)
  })
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  // 検査が終わったらサーバが残っていても終わる
  server.unref()
})
const base = `http://127.0.0.1:${port}`

// ---- 検査用の版を作る ----
const userData = path.join(work, 'userData')
const resultFile = path.join(work, 'result.json')
const config = {
  marker: TEST_MARKER,
  bundleId: TEST_ID,
  appName: APP_NAME,
  feedUrl: `${base}/latest-mac.json`,
  downloadPrefix: `${base}/download/`,
  publicKeys: [pub],
  userData,
  checkDelayMs: 500,
  autoStart: true,
  resultFile,
  directRelaunch: true,
}
const configFile = path.join(work, 'update-test.json')
fs.writeFileSync(configFile, JSON.stringify(config))
const dist = path.join(work, 'dist')
console.log('[update-package] 検査用の版をビルドします')
execFileSync(process.execPath, ['scripts/build.mjs', '--update-test', configFile, '--outdir', dist],
  {cwd: root, stdio: ['ignore', 'ignore', 'pipe']})

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
function packageVersion(version) {
  const output = path.join(work, `out-${version}`)
  const builderConfig = {
    ...pkg.build,
    appId: TEST_ID,
    productName: PRODUCT,
    files: [`${rel(dist)}/**/*`, 'package.json'],
    extraMetadata: {main: `${rel(dist)}/main/main.js`, version, productName: PRODUCT},
    directories: {output: rel(output)},
    publish: null,
    mac: {...pkg.build.mac, target: [{target: 'dir', arch: 'arm64'}]},
  }
  const file = path.join(work, `builder-${version}.json`)
  fs.writeFileSync(file, JSON.stringify(builderConfig))
  console.log(`[update-package] ${version} をパッケージにします`)
  execFileSync(path.join(root, 'node_modules/.bin/electron-builder'), ['--mac', '--arm64', '--dir', '--config', rel(file),
    '--publish', 'never'], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']})
  const app = path.join(output, 'mac-arm64', APP_NAME)
  assert.ok(fs.existsSync(app), `${app} was not built`)
  return app
}
const appA = packageVersion(OLD)
const appB = packageVersion(NEW)

// B を配る: zip(ditto)と署名つきの latest-mac.json
const zipDir = path.join(serve, 'download', `v${NEW}`)
fs.mkdirSync(zipDir, {recursive: true})
const zip = path.join(zipDir, zipName(NEW))
execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appB, zip])
const size = fs.statSync(zip).size
const sha256 = createHash('sha256').update(fs.readFileSync(zip)).digest('hex')
const notes = '- 検査用の版'
fs.writeFileSync(path.join(serve, 'latest-mac.json'), JSON.stringify({
  version: NEW, notes, pub_date: new Date().toISOString(), url: `${base}/download/v${NEW}/${zipName(NEW)}`, sha256, size,
  signature: sign(null, signedMessage(NEW, sha256, size, notes), privateKey).toString('base64'),
}))

// A を「アプリケーション」の代わりのフォルダへ置き、直接起動する(LaunchServices を通すと、書類フォルダの確認が出る)
const applications = path.join(work, 'Applications')
fs.mkdirSync(applications)
const installed = path.join(applications, APP_NAME)
execFileSync('/usr/bin/ditto', [appA, installed])
const versionOf = (app) => execFileSync('/usr/bin/plutil',
  ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], {encoding: 'utf8'}).trim()
assert.equal(versionOf(installed), OLD)

console.log(`[update-package] ${OLD} を起動します(窓が出ます)`)
const started = Date.now()
const a = spawn(path.join(installed, 'Contents/MacOS', PRODUCT), [], {stdio: ['ignore', 'pipe', 'pipe'], detached: true})
let logs = ''
a.stdout.on('data', (chunk) => { logs += chunk })
a.stderr.on('data', (chunk) => { logs += chunk })
a.unref()

const deadline = Date.now() + 120_000
while (!fs.existsSync(resultFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500))
try {
  assert.ok(fs.existsSync(resultFile), `no result within 120s\n${logs.split('\n').filter((l) => /update|Error/.test(l)).join('\n')}`)
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  assert.deepEqual(result, {version: NEW, failure: null})
  assert.equal(versionOf(installed), NEW, 'the installed app was not replaced')
  // 入れ替わった後の版が、退避した元の版とダウンロードを片付けている
  assert.ok(!fs.existsSync(path.join(userData, 'updates')), 'updates/ was not cleaned')
  assert.deepEqual(fs.readdirSync(applications), [APP_NAME])
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed], {stdio: 'pipe'})
  assert.deepEqual(fingerprint(), before, '~/.claude/settings.json or ~/.codex/hooks.json changed')
} catch (error) {
  console.error(logs.split('\n').filter((line) => /\[update\]|Error|error/.test(line)).slice(-20).join('\n'))
  console.error(error)
  process.exit(1)
}
console.log(`UPDATE PACKAGE SMOKE PASS (${OLD} → ${NEW} in ${Math.round((Date.now() - started) / 1000)}s)`)
// A の出力のパイプが残っていても終わる(後片付けは exit の処理で行う)
process.exit(0)
