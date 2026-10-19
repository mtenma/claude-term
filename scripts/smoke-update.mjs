// アプリの更新(src/main/updateCore.ts と scripts/release.mjs)の検証。GUI は使わない。
// 偽のアプリ・zip・鍵・HTTP サーバ(127.0.0.1)は dist-test の中に作り、github.com には行かない。
// /Applications のアプリと、普段の userData には触れない
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {execFileSync, spawn} from 'node:child_process'
import {generateKeyPairSync, sign} from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, 'dist-test', `update-smoke-${process.pid}`)
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const mounts = []
fs.rmSync(work, {recursive: true, force: true})
fs.mkdirSync(work, {recursive: true})
process.on('exit', () => {
  for (const mount of mounts) {
    try {
      execFileSync('/usr/bin/hdiutil', ['detach', '-force', mount], {stdio: 'ignore'})
    } catch {
      // 外れていればよい
    }
  }
  // 作った .app は(起動しなくても)LaunchServices に登録されるので、本物の bundle ID と混ざらないよう外す。
  // 入れ替えで動かした元の場所の登録も残るので、登録の一覧から dist-test の下のものを探す
  unregisterUnder(work)
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
      // もう無いパスは外せないことがある。片付けの失敗で結果を変えない
    }
  }
}

const bundleFile = path.join(work, 'update.mjs')
await esbuild.build({
  absWorkingDir: root,
  stdin: {contents: `export * from './src/main/updateCore'`, resolveDir: root, loader: 'ts'},
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundleFile, logLevel: 'silent',
})
const U = await import(pathToFileURL(bundleFile).href)
const R = await import(pathToFileURL(path.join(root, 'scripts/release.mjs')).href)

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}\n     ${error.stack?.split('\n').slice(0, 3).join('\n     ') ?? error}`)
  }
}
async function rejectsWith(promise, code, label) {
  try {
    await promise
  } catch (error) {
    const codes = Array.isArray(code) ? code : [code]
    assert.ok(codes.includes(error.code), `${label}: code ${error.code} (${error.message}) not in ${codes}`)
    return error
  }
  assert.fail(`${label}: did not throw`)
}
const throwsCode = (fn, code, label) => rejectsWith(Promise.resolve().then(fn), code, label)

// ---- 鍵と署名 ----
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
function makeKey() {
  const {privateKey} = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({format: 'jwk'})
  return {
    seed: Buffer.from(jwk.d, 'base64url').toString('base64'),
    pub: Buffer.from(jwk.x, 'base64url').toString('base64'),
    privateKey,
  }
}
const key = makeKey()
const otherKey = makeKey()
const signWith = (k, message) => sign(null, message, k.privateKey).toString('base64')

const port = await new Promise((resolve) => {
  const server = http.createServer(route)
  server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  server.unref()
})
const base = `http://127.0.0.1:${port}`
const PREFIX = `${base}/download/`
const CHECK = {publicKeys: [key.pub], downloadPrefix: PREFIX}

function manifest(fields = {}, k = key) {
  const info = {version: '0.1.9', notes: '- 日本語の変更点\n- 2 行目', sha256: 'a'.repeat(64), size: 1234, ...fields}
  info.url ??= `${PREFIX}v${info.version}/${U.zipName(info.version)}`
  info.signature ??= signWith(k, U.signedMessage(info.version, info.sha256, info.size, info.notes))
  return info
}

// ---- HTTP サーバ ----
let zipBytes = Buffer.alloc(0)
function route(req, res) {
  const url = new URL(req.url, base)
  if (url.pathname === '/manifest') {
    res.writeHead(200, {'content-type': 'application/json'})
    res.end(JSON.stringify(manifest()))
  } else if (url.pathname === '/redirect') {
    res.writeHead(302, {location: '/manifest'})
    res.end()
  } else if (url.pathname === '/big') {
    // Content-Length なしで 64KB を超える
    res.writeHead(200)
    res.write('{"x":"')
    res.end('y'.repeat(70 * 1024))
  } else if (url.pathname === '/html') {
    res.writeHead(200, {'content-type': 'text/html'})
    res.end('<html>login</html>')
  } else if (url.pathname === '/zip') {
    res.writeHead(200, {'content-length': zipBytes.length})
    res.end(zipBytes)
  } else if (url.pathname === '/zip-long') {
    res.writeHead(200)
    res.end(Buffer.concat([zipBytes, Buffer.from('extra')]))
  } else if (url.pathname === '/zip-short') {
    // 申告より短く切る
    res.writeHead(200, {'content-length': zipBytes.length})
    res.write(zipBytes.subarray(0, 10))
    res.destroy()
  } else if (url.pathname === '/zip-wrong-length') {
    res.writeHead(200, {'content-length': zipBytes.length + 1})
    res.end(Buffer.concat([zipBytes, Buffer.from('x')]))
  } else if (url.pathname === '/stall') {
    res.writeHead(200)
    res.write(zipBytes.subarray(0, 4))
    // 止まったまま(閉じない)
  } else {
    res.writeHead(404)
    res.end()
  }
}
const nodeFetch = (url, init) => fetch(url, init)

// ---- 版 ----
await check('版の比べ方(0.1.10 > 0.1.9、先頭 0 と桁あふれは形が違う)', () => {
  assert.equal(U.isNewer('0.1.10', '0.1.9'), true)
  assert.equal(U.isNewer('0.2.0', '0.1.99'), true)
  assert.equal(U.isNewer('1.0.0', '0.99.99'), true)
  assert.equal(U.isNewer('0.1.9', '0.1.9'), false)
  assert.equal(U.isNewer('0.1.8', '0.1.9'), false)
  assert.equal(U.versionParts('0.1.09'), null)
  assert.equal(U.versionParts('01.2.3'), null)
  assert.equal(U.versionParts('0.1.9999999'), null)
  assert.equal(U.versionParts('0.1.9-beta'), null)
  assert.equal(U.isNewer('0.1.09', '0.1.8'), false)
})

// ---- 署名つきの更新情報 ----
await check('正しい署名つきの情報を受け付ける(日本語と改行の変更の内容)', () => {
  const release = U.parseRelease(JSON.stringify(manifest()), CHECK)
  assert.equal(release.version, '0.1.9')
  assert.equal(release.notes, '- 日本語の変更点\n- 2 行目')
})

await check('書き換え・別の鍵・形の違いを断る', () => {
  const good = manifest()
  const cases = {
    notes: {...good, notes: good.notes + '!'},
    sha256: {...good, sha256: 'b'.repeat(64)},
    size: {...good, size: 1235},
    version: {...good, version: '0.1.10'},
    otherKey: manifest({}, otherKey),
    shortSignature: {...good, signature: good.signature.slice(4)},
    url: {...good, url: 'https://example.com/x.zip'},
    sizeString: {...good, size: '1234'},
    badSha: {...good, sha256: 'A'.repeat(64)},
    leadingZero: manifest({version: '0.1.09'}),
  }
  for (const [label, info] of Object.entries(cases)) {
    assert.throws(() => U.parseRelease(JSON.stringify(info), CHECK), undefined, label)
  }
  assert.throws(() => U.parseRelease('not json', CHECK))
  assert.throws(() => U.parseRelease('null', CHECK))
})

await check('鍵を 2 つ持てる(鍵の入れ替えの途中)', () => {
  const release = U.parseRelease(JSON.stringify(manifest({}, otherKey)), {...CHECK, publicKeys: [key.pub, otherKey.pub]})
  assert.equal(release.version, '0.1.9')
})

await check('更新情報の取得: 404 は「無し」、302 をたどる、64KB 超え・HTML を断る', async () => {
  assert.equal(await U.fetchRelease(nodeFetch, `${base}/missing`, CHECK, 5000), null)
  assert.equal((await U.fetchRelease(nodeFetch, `${base}/redirect`, CHECK, 5000)).version, '0.1.9')
  await assert.rejects(U.fetchRelease(nodeFetch, `${base}/big`, CHECK, 5000), /too large/)
  await assert.rejects(U.fetchRelease(nodeFetch, `${base}/html`, CHECK, 5000), /not JSON/)
  await assert.rejects(U.fetchRelease(nodeFetch, `${base}/stall`, CHECK, 300))
})

// ---- 偽のアプリ ----
function plist(id, version, executable) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`
}
// 偽のアプリには検査用の bundle ID を使う(LaunchServices の登録が残っても、本物のアプリと混ざらない)
const SMOKE_ID = 'jp.sabira.claude-term.smoke'
function makeApp(dir, {name = 'Claude Term.app', id = SMOKE_ID, version = '0.1.9', asar = 'app'} = {}) {
  const app = path.join(dir, name)
  const executable = name.replace(/\.app$/, '')
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), {recursive: true})
  fs.mkdirSync(path.join(app, 'Contents/Resources'), {recursive: true})
  fs.copyFileSync('/usr/bin/true', path.join(app, 'Contents/MacOS', executable))
  fs.writeFileSync(path.join(app, 'Contents/Info.plist'), plist(id, version, executable))
  fs.writeFileSync(path.join(app, 'Contents/Resources/app.asar'), asar)
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '-s', '-', app], {stdio: 'pipe'})
  return app
}
function zipApp(app, zip) {
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  return zip
}
const sha256File = (file) => execFileSync('/usr/bin/shasum', ['-a', '256', file], {encoding: 'utf8'}).split(' ')[0]
const IDENTITY = {appName: 'Claude Term.app', bundleId: SMOKE_ID}

const fixtures = path.join(work, 'fixtures')
fs.mkdirSync(fixtures, {recursive: true})
const goodZip = zipApp(makeApp(path.join(fixtures, 'good')), path.join(fixtures, 'good.zip'))
zipBytes = fs.readFileSync(goodZip)
const zipRelease = {
  version: '0.1.9', notes: '', url: `${base}/zip`, sha256: sha256File(goodZip), size: zipBytes.length,
}

// ---- ダウンロード ----
async function download(pathname, opts = {}) {
  const dest = path.join(work, `dl-${Math.random().toString(36).slice(2)}.zip`)
  const ctl = new AbortController()
  if (opts.abortAfter) setTimeout(() => ctl.abort(), opts.abortAfter)
  let last = 0
  await U.downloadZip(nodeFetch, {...zipRelease, url: `${base}${pathname}`, ...opts.release}, dest, {
    stallMs: opts.stallMs ?? 5000, signal: ctl.signal, onProgress: (received) => {
      last = received
    },
  })
  return {dest, last}
}

await check('ダウンロード: 大きさと SHA-256 が合えば書き、進み具合を知らせる', async () => {
  const {dest, last} = await download('/zip')
  assert.equal(last, zipBytes.length)
  assert.equal(sha256File(dest), zipRelease.sha256)
  assert.equal(fs.statSync(dest).mode & 0o777, 0o600)
})

await check('ダウンロード: 長い・短い・申告の違い・SHA-256 の違い・止まる・中止', async () => {
  await rejectsWith(download('/zip-long'), 'corrupt', 'longer')
  await rejectsWith(download('/zip-short'), ['network', 'corrupt'], 'shorter')
  await rejectsWith(download('/zip-wrong-length'), 'corrupt', 'content-length')
  await rejectsWith(download('/zip', {release: {sha256: 'c'.repeat(64)}}), 'corrupt', 'sha256')
  const stalled = await rejectsWith(download('/stall', {stallMs: 300}), 'network', 'stall')
  assert.match(stalled.message, /stalled/)
  await rejectsWith(download('/stall', {abortAfter: 100}), 'cancelled', 'cancel')
  // 中止済みの signal(準備中に［中止］・⌘Q)では、始めずに止まる(abort の知らせは来ない)
  const aborted = new AbortController()
  aborted.abort()
  const started = Date.now()
  await rejectsWith(U.downloadZip(nodeFetch, {...zipRelease, url: `${base}/zip`}, path.join(work, 'never.zip'),
    {stallMs: 5000, signal: aborted.signal, onProgress: () => {}}), 'cancelled', 'pre-aborted')
  assert.ok(Date.now() - started < 1000)
  assert.ok(!fs.existsSync(path.join(work, 'never.zip')))
  await rejectsWith(download('/missing'), 'network', '404')
})

// ---- 展開と中身の確かめ ----
async function extract(zip, release = zipRelease) {
  const dir = fs.mkdtempSync(path.join(work, 'extract-'))
  return U.extractApp(zip, dir, release, IDENTITY)
}

await check('展開: 確かめ済みの .app を返し、ネットから来た印を外す', async () => {
  const zip = path.join(fixtures, 'quarantined.zip')
  fs.copyFileSync(goodZip, zip)
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0083;00000000;smoke;', zip])
  const app = await extract(zip)
  assert.equal(path.basename(app), 'Claude Term.app')
  assert.ok(!execFileSync('/usr/bin/xattr', ['-lr', app], {encoding: 'utf8'}).includes('com.apple.quarantine'))
})

await check('展開: 名札・版・署名の壊れ・中身が 2 つ・zip でないものを断る', async () => {
  const otherId = zipApp(makeApp(path.join(fixtures, 'id'), {id: 'jp.example.other'}), path.join(fixtures, 'id.zip'))
  await rejectsWith(extract(otherId), 'invalid_app', 'bundle id')
  const oldVersion = zipApp(makeApp(path.join(fixtures, 'ver'), {version: '0.1.8'}), path.join(fixtures, 'ver.zip'))
  await rejectsWith(extract(oldVersion), 'invalid_app', 'version')
  const brokenApp = makeApp(path.join(fixtures, 'broken'))
  fs.appendFileSync(path.join(brokenApp, 'Contents/Resources/app.asar'), 'tampered')
  await rejectsWith(extract(zipApp(brokenApp, path.join(fixtures, 'broken.zip'))), 'invalid_app', 'signature')
  const two = path.join(fixtures, 'two')
  makeApp(two)
  fs.writeFileSync(path.join(two, 'extra.txt'), 'x')
  const twoZip = path.join(fixtures, 'two.zip')
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', two, twoZip])
  await rejectsWith(extract(twoZip), 'invalid_app', 'two entries')
  const notZip = path.join(fixtures, 'not.zip')
  fs.writeFileSync(notZip, 'not a zip')
  await rejectsWith(extract(notZip), 'invalid_app', 'not a zip')
})

// ---- 入れ替えられるかの確かめ ----
await check('置き場所: 書き込める同じボリュームなら通り、試しのフォルダを残さない', () => {
  const place = path.join(work, 'place-ok')
  const app = makeApp(place)
  const updates = path.join(work, 'updates-ok')
  U.checkInstallable(app, updates)
  assert.deepEqual(fs.readdirSync(place), ['Claude Term.app'])
  assert.deepEqual(fs.readdirSync(updates), [])
})

await check('置き場所: .app でない・App Translocation・書き込めない親を断る', async () => {
  const updates = path.join(work, 'updates-ng')
  await throwsCode(() => U.checkInstallable(path.join(work, 'x/Contents/MacOS/x'), updates), 'location', 'not .app')
  await throwsCode(() => U.checkInstallable('/private/var/folders/x/AppTranslocation/y/d/Claude Term.app', updates),
    'location', 'translocation')
  const locked = path.join(work, 'locked')
  const app = makeApp(locked)
  fs.chmodSync(locked, 0o555)
  try {
    await throwsCode(() => U.checkInstallable(app, updates), 'location', 'read-only parent')
  } finally {
    fs.chmodSync(locked, 0o755)
  }
})

await check('置き場所: 別のボリュームのアプリを断る(rename の EXDEV は案内の文を分ける)', async () => {
  const image = path.join(work, 'vol.dmg')
  execFileSync('/usr/bin/hdiutil', ['create', '-size', '4m', '-fs', 'APFS', '-volname', 'CTUPDATE', image], {stdio: 'pipe'})
  const mountRoot = path.join(work, 'mnt')
  fs.mkdirSync(mountRoot)
  const out = execFileSync('/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountroot', mountRoot, image],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']})
  const mount = out.trim().split('\n').at(-1).split('\t').at(-1).trim()
  mounts.push(mount)
  const app = makeApp(mount)
  try {
    await throwsCode(() => U.checkInstallable(app, path.join(work, 'updates-vol')), 'other_volume', 'other volume')
  } finally {
    try {
      execFileSync(LSREGISTER, ['-u', app], {stdio: 'ignore'})
    } catch {
      // nobrowse のボリュームは登録されないことがある
    }
    execFileSync('/usr/bin/hdiutil', ['detach', mount], {stdio: 'pipe'})
    mounts.pop()
  }
})

await check('ほかの起動: 同じ実行ファイルだけを数え、自分と Codex の中継を除く', () => {
  const exe = '/Applications/Claude Term.app/Contents/MacOS/Claude Term'
  const ps = [
    ' 100 /Applications/Claude Term.app/Contents/MacOS/Claude Term',
    ' 200 /Applications/Claude Term.app/Contents/MacOS/Claude Term --update-feed x',
    ' 300 /Applications/Claude Term.app/Contents/MacOS/Claude Term /Applications/Claude Term.app/Contents/Resources/app.asar/dist/main/codexHookRelay.js',
    ' 400 /Applications/Claude Term.app/Contents/Frameworks/Claude Term Helper.app/Contents/MacOS/Claude Term Helper --type=gpu',
    ' 500 /Applications/Claude Term.app/Contents/MacOS/Claude Terminal',
    ' 600 /bin/zsh',
  ].join('\n')
  assert.deepEqual(U.otherInstances(ps, exe, 100), [200])
})

await check('空き容量: 足りなければ必要な MB を返す', async () => {
  const error = await throwsCode(() => U.checkDiskSpace(work, Number.MAX_SAFE_INTEGER / 8), 'disk_space', 'disk')
  assert.match(error.message, /^\d+$/)
  U.checkDiskSpace(work, 1000)
})

// ---- 入れ替え ----
function swapFixture(label) {
  const dir = path.join(work, `swap-${label}`, 'アプリ 置き場')
  const current = makeApp(dir, {version: '0.1.8'})
  const next = makeApp(path.join(work, `swap-${label}`, 'new'), {version: '0.1.9'})
  const backup = path.join(work, `swap-${label}`, 'updates', '0.1.9', 'previous', 'Claude Term.app')
  const versionOf = (app) => execFileSync('/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(app, 'Contents/Info.plist')], {encoding: 'utf8'}).trim()
  return {current, next, backup, versionOf}
}

await check('入れ替え: 新しい版を置き、元の版を退避先に残す(日本語と空白のパス)', () => {
  const f = swapFixture('ok')
  assert.deepEqual(U.swapApp(f.current, f.next, f.backup), {ok: true})
  assert.equal(f.versionOf(f.current), '0.1.9')
  assert.equal(f.versionOf(f.backup), '0.1.8')
  assert.ok(!fs.existsSync(f.next))
  assert.ok(!fs.existsSync(path.join(f.current, 'Claude Term.app')), 'nested')
})

await check('入れ替え: 新しい版を置けなければ元に戻し、退避先が既にあれば何もしない', () => {
  const f = swapFixture('fail')
  fs.rmSync(f.next, {recursive: true})
  const result = U.swapApp(f.current, f.next, f.backup)
  assert.equal(result.ok, false)
  assert.equal(result.restored, true)
  assert.equal(result.reason, 'ENOENT')
  assert.equal(f.versionOf(f.current), '0.1.8')

  const g = swapFixture('exists')
  fs.mkdirSync(g.backup, {recursive: true})
  assert.deepEqual(U.swapApp(g.current, g.next, g.backup), {ok: false, restored: true, reason: 'backup exists'})
  assert.equal(g.versionOf(g.current), '0.1.8')
  assert.ok(!fs.existsSync(path.join(g.backup, 'Claude Term.app')), 'nested into backup')
})

await check('入れ替え: 行き先に中身があれば中へ入れずに断る(mv と違って入れ子にしない)', () => {
  const f = swapFixture('nonempty')
  // 1 つ目の後に、誰かが今の場所へ物を置いた状況(rename は ENOTEMPTY で断り、戻しも同じく断る)
  fs.renameSync(f.current, f.current + '.moved')
  fs.mkdirSync(path.join(f.current, 'Contents'), {recursive: true})
  fs.writeFileSync(path.join(f.current, 'Contents', 'x'), 'x')
  assert.throws(() => fs.renameSync(f.next, f.current), /ENOTEMPTY|EEXIST/)
  assert.ok(!fs.existsSync(path.join(f.current, 'Claude Term.app')))
})

// ---- 開き直し ----
await check('開き直し: 元のプロセスが終わるのを待ってから起動する(パスは引数で渡す)', async () => {
  const dir = path.join(work, '開き直し $(touch injected) `x`')
  fs.mkdirSync(dir, {recursive: true})
  const marker = path.join(dir, 'launched')
  const launcher = path.join(dir, 'launch "me".sh')
  fs.writeFileSync(launcher, '#!/bin/sh\necho "$0" > "$MARKER"\n', {mode: 0o755})
  const sleeper = spawn('/bin/sleep', ['1.5'], {stdio: 'ignore'})
  await U.spawnRelaunch({
    pid: sleeper.pid, app: path.join(dir, 'Claude Term.app'), bundleId: 'jp.sabira.claude-term.smoke-none',
    executable: launcher, env: {PATH: '/usr/bin:/bin', MARKER: marker},
  })
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.ok(!fs.existsSync(marker), 'launched before the process exited')
  await new Promise((resolve) => sleeper.once('exit', resolve))
  const deadline = Date.now() + 5000
  while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), launcher)
  assert.ok(!fs.existsSync(path.join(work, 'injected')) && !fs.existsSync('injected'), 'command injection')
})

// ---- 次の起動 ----
await check('予約の記録: 書いて読める・壊れていれば broken・動いているアプリが中にあれば消さない', () => {
  const dir = path.join(work, 'pending')
  assert.equal(U.readPending(dir), null)
  U.writePending(dir, {from: '0.1.8', to: '0.1.9', at: 1})
  assert.deepEqual(U.readPending(dir), {from: '0.1.8', to: '0.1.9', at: 1, failure: undefined})
  assert.equal(fs.statSync(path.join(dir, 'pending.json')).mode & 0o777, 0o600)
  U.writePending(dir, {from: '0.1.8', to: '0.1.9', at: 2, failure: 'swap_failed'})
  assert.equal(U.readPending(dir).failure, 'swap_failed')
  fs.writeFileSync(path.join(dir, 'pending.json'), '{"from":"0.1.8","to":"../x"}')
  assert.equal(U.readPending(dir), 'broken')
  fs.writeFileSync(path.join(dir, 'pending.json'), '{')
  assert.equal(U.readPending(dir), 'broken')
  U.removePending(dir)
  assert.equal(U.readPending(dir), null)
  fs.mkdirSync(path.join(dir, '0.1.9', 'previous', 'Claude Term.app'), {recursive: true})
  assert.equal(U.cleanUpdates(dir, path.join(dir, '0.1.9', 'previous', 'Claude Term.app')), false)
  assert.ok(fs.existsSync(dir))
  assert.equal(U.cleanUpdates(dir, '/Applications/Claude Term.app'), true)
  assert.ok(!fs.existsSync(dir))
})

// ---- release.mjs ----
function releaseRoot(label, {version = '0.1.9', notes = '- 変更点\n', keys = [key.pub]} = {}) {
  const dir = path.join(work, `release-${label}`)
  fs.mkdirSync(path.join(dir, 'docs/releases'), {recursive: true})
  fs.mkdirSync(path.join(dir, 'src/main'), {recursive: true})
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({version}))
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({version, packages: {'': {version}}}))
  if (notes !== null) fs.writeFileSync(path.join(dir, 'docs/releases', `${version}.txt`), notes)
  fs.writeFileSync(path.join(dir, 'src/main/updateKey.ts'),
    `export const UPDATE_PUBLIC_KEYS: readonly string[] = [${keys.map((k) => `'${k}'`).join(', ')}]\n`)
  return dir
}

await check('release check: タグの形・版の食い違い・変更の内容の形を断る', () => {
  const ok = releaseRoot('check')
  assert.equal(R.check('v0.1.9', ok).version, '0.1.9')
  for (const tag of ['0.1.9', 'v0.1.9-beta', 'v0.1.9;x', 'v0.1.09', '']) assert.throws(() => R.check(tag, ok), undefined, tag)
  assert.throws(() => R.check('v0.1.10', ok), /package.json/)
  const lock = releaseRoot('lock')
  fs.writeFileSync(path.join(lock, 'package-lock.json'), JSON.stringify({version: '0.1.9', packages: {'': {version: '0.1.8'}}}))
  assert.throws(() => R.check('v0.1.9', lock), /package-lock/)
  for (const [label, notes] of Object.entries({
    missing: null, empty: '\n', crlf: '- a\r\n', heading: '# 見出し\n', mention: '- @someone\n', code: '- `x`\n',
    html: '- <b>\n', long: 'あ'.repeat(2001), bom: '﻿- a\n',
    issue: '- #12 を直した\n', quote: '> 引用\n', link: '- [a](b)\n', table: '| a |\n', emphasis: '- *強調*\n',
    underscore: '- a_b\n', entity: '- &amp;\n', rule: '- a\n---\n',
  })) {
    assert.throws(() => R.check('v0.1.9', releaseRoot(`notes-${label}`, {notes})), undefined, label)
  }
})

await check('release sign と verify: アプリと同じ確かめで通り、鍵の組の違い・zip の差し替えを断る', () => {
  const rootDir = releaseRoot('sign')
  const dir = path.join(work, 'release-sign-out')
  fs.mkdirSync(dir)
  const zip = path.join(dir, R.zipName('0.1.9'))
  fs.copyFileSync(goodZip, zip)
  const built = {version: '0.1.9', size: zipBytes.length, sha256: zipRelease.sha256}
  fs.writeFileSync(path.join(dir, 'release.json'), JSON.stringify(built))
  process.env.UPDATE_SIGNING_KEY = 'leak-check'
  const latest = R.signRelease('v0.1.9', dir, {root: rootDir, key: key.seed, now: new Date('2026-10-20T01:02:03.456Z')})
  assert.equal(process.env.UPDATE_SIGNING_KEY, undefined, 'key left in env')
  assert.equal(latest.pub_date, '2026-10-20T01:02:03Z')
  assert.ok(!fs.existsSync(path.join(dir, 'release.json')))
  assert.match(fs.readFileSync(path.join(dir, 'notes.md'), 'utf8'), /^- 変更点\n\n## 手で入れるとき/)
  // アプリの確かめ(updateCore.parseRelease)でも通る
  const text = fs.readFileSync(path.join(dir, 'latest-mac.json'), 'utf8')
  const parsed = U.parseRelease(text, {publicKeys: [key.pub], downloadPrefix: 'https://github.com/mtenma/claude-term/releases/download/'})
  assert.equal(parsed.sha256, zipRelease.sha256)
  R.verifyLatest(path.join(dir, 'latest-mac.json'), zip, {root: rootDir})

  const wrongKeyRoot = releaseRoot('sign-wrong', {keys: [otherKey.pub]})
  const dir2 = path.join(work, 'release-sign-out2')
  fs.mkdirSync(dir2)
  fs.copyFileSync(goodZip, path.join(dir2, R.zipName('0.1.9')))
  fs.writeFileSync(path.join(dir2, 'release.json'), JSON.stringify(built))
  assert.throws(() => R.signRelease('v0.1.9', dir2, {root: wrongKeyRoot, key: key.seed}), /組になって/)
  assert.throws(() => R.signRelease('v0.1.9', dir2, {root: rootDir, key: ''}), /秘密鍵/)
  fs.writeFileSync(path.join(dir2, 'release.json'), JSON.stringify({...built, sha256: 'd'.repeat(64)}))
  assert.throws(() => R.signRelease('v0.1.9', dir2, {root: rootDir, key: key.seed}), /build ジョブ/)
  const tampered = path.join(dir2, 'tampered.zip')
  fs.copyFileSync(goodZip, tampered)
  fs.appendFileSync(tampered, 'x')
  assert.throws(() => R.verifyLatest(path.join(dir, 'latest-mac.json'), tampered, {root: rootDir}))
})

await check('release bundle: 検査用の版・公開鍵の入っていない版・名札の違いを断る', () => {
  const rootDir = releaseRoot('bundle')
  // release.mjs は本物の bundle ID を求めるので、ここだけ本物の ID で作る(ASCII のパスなので登録を外せる)
  const make = (label, opts) => {
    const dir = path.join(work, `bundle-${label}`)
    const app = makeApp(path.join(dir, 'mac-arm64'), {id: 'jp.sabira.claude-term', ...opts})
    fs.writeFileSync(path.join(dir, R.dmgName('0.1.9')), 'dmg')
    return {app, dmgDir: dir, out: path.join(dir, 'out')}
  }
  const ok = make('ok', {asar: `const UPDATE_PUBLIC_KEYS = ['${key.pub}']`})
  const result = R.bundle('v0.1.9', ok.out, {root: rootDir, app: ok.app, dmgDir: ok.dmgDir})
  assert.deepEqual(fs.readdirSync(ok.out).sort(), [R.dmgName('0.1.9'), R.zipName('0.1.9'), 'release.json'].sort())
  assert.equal(result.size, fs.statSync(path.join(ok.out, R.zipName('0.1.9'))).size)
  const marker = make('marker', {asar: `${key.pub} ${R.TEST_MARKER}`})
  assert.throws(() => R.bundle('v0.1.9', marker.out, {root: rootDir, app: marker.app, dmgDir: marker.dmgDir}), /検査用/)
  const noKey = make('nokey', {asar: 'no key'})
  assert.throws(() => R.bundle('v0.1.9', noKey.out, {root: rootDir, app: noKey.app, dmgDir: noKey.dmgDir}), /公開鍵/)
  const other = make('other', {id: 'jp.example.other', asar: key.pub})
  assert.throws(() => R.bundle('v0.1.9', other.out, {root: rootDir, app: other.app, dmgDir: other.dmgDir}), /名札/)
  assert.throws(() => R.bundle('v0.1.9', path.join(work, 'nokeys'), {root: releaseRoot('nokeys', {keys: []}), app: ok.app,
    dmgDir: ok.dmgDir}), /公開鍵がありません/)
})

await check('release keygen: リポジトリの中には作らない', () => {
  assert.throws(() => R.keygen(path.join(work, 'update.key')), /リポジトリの外/)
  assert.ok(!fs.existsSync(path.join(work, 'update.key')))
})

await check('公開鍵の読み取り: 今の src/main/updateKey.ts を読める', () => {
  const keys = R.publicKeys()
  assert.ok(Array.isArray(keys))
  for (const k of keys) assert.match(k, /^[A-Za-z0-9+/]{43}=$/)
})

if (failures) {
  console.error(`UPDATE SMOKE FAILED (${failures})`)
  process.exit(1)
}
console.log('UPDATE SMOKE PASS')
