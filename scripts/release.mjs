// アプリの更新のリリース(手順 docs/release.md)。Node の標準だけで書く(署名のジョブで npm を動かさないため)。
// GitHub Actions(.github/workflows/release.yml)から呼ぶ。手元でも流せる。
//
//   node scripts/release.mjs check <タグ>
//     タグ v<版> と package.json・package-lock.json の版、変更の内容 docs/releases/<版>.txt を確かめる
//   node scripts/release.mjs bundle <タグ> <出力フォルダ>
//     release/mac-arm64/Claude Term.app を確かめ、配る zip・DMG と、署名する前の情報 release.json を作る(鍵は使わない)
//   node scripts/release.mjs sign <タグ> <フォルダ>
//     zip を確かめ直し、環境変数 UPDATE_SIGNING_KEY の秘密鍵で署名し、src/main/updateKey.ts の公開鍵で確かめてから
//     latest-mac.json とリリースのページの説明 notes.md を作る
//   node scripts/release.mjs verify <latest-mac.json> [zip]
//     アプリと同じ確かめを手で流す
//   node scripts/release.mjs keygen <秘密鍵のファイル>
//     署名の鍵を作る(最初の 1 回だけ。git の作業ツリーの中には作らない。あるファイルは上書きしない)
import {execFileSync} from 'node:child_process'
import {createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify} from 'node:crypto'
import {closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync,
  writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'mtenma/claude-term'
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`
const BUNDLE_ID = 'jp.sabira.claude-term'
const APP_NAME = 'Claude Term.app'
// 検査用の版(scripts/smoke-update-package.mjs)に埋め込む目印。配る版の app.asar にあれば止める
export const TEST_MARKER = 'CLAUDE_TERM_UPDATE_TEST_BUILD'
const VERSION = '(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})\\.(0|[1-9]\\d{0,5})'
const TAG_RE = new RegExp(`^v(${VERSION})$`)
const VERSION_RE = new RegExp(`^${VERSION}$`)
const NOTES_LIMIT = 2000
// Ed25519 の秘密鍵(raw 32 バイト)を PKCS#8 にする前置き
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export const zipName = (version) => `Claude-Term-${version}-arm64-mac.zip`
export const dmgName = (version) => `Claude-Term-${version}-arm64.dmg`

class ReleaseError extends Error {}
const fail = (message) => {
  throw new ReleaseError(message)
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex')

/** 署名する中身。src/main/updateCore.ts の signedMessage と同じ形にする */
export function signedMessage(version, sha256, size, notes) {
  return Buffer.from(`claude-term-update-v1\n${version}\n${sha256}\n${size}\n${sha256Hex(notes)}\n`, 'utf8')
}

function fileSha256(file) {
  // 大きな zip を一度に読み込まないよう、1MB ずつ読む
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(1 << 20)
    let read
    while ((read = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

/** src/main/updateKey.ts の公開鍵(raw 32 バイトの base64)。アプリに入るものと同じ */
export function publicKeys(root = repoRoot) {
  const text = readFileSync(path.join(root, 'src/main/updateKey.ts'), 'utf8')
  const list = /UPDATE_PUBLIC_KEYS: readonly string\[\] = \[([^\]]*)\]/.exec(text)
  if (!list) fail('src/main/updateKey.ts に UPDATE_PUBLIC_KEYS が見つかりません')
  return [...list[1].matchAll(/'([A-Za-z0-9+/]{43}=)'/g)].map((m) => m[1])
}

function verifyWith(keys, message, signature) {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false
  const sig = Buffer.from(signature, 'base64')
  return keys.some((key) => {
    const x = Buffer.from(key, 'base64').toString('base64url')
    return verify(null, message, createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x}, format: 'jwk'}), sig)
  })
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

function readPlist(file) {
  return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], {encoding: 'utf8'}))
}

// ---- check ----

/** 変更の内容。お知らせの窓(文字のまま)とリリースのページ(Markdown)の両方で同じに見える形だけを許す */
function readNotes(version, root = repoRoot) {
  const file = path.join(root, 'docs/releases', `${version}.txt`)
  if (!existsSync(file)) fail(`変更の内容 docs/releases/${version}.txt がありません`)
  const text = readFileSync(file, 'utf8')
  if (text.startsWith('﻿')) fail(`docs/releases/${version}.txt の先頭に BOM があります`)
  if (text.includes('\r')) fail(`docs/releases/${version}.txt の改行が CRLF です(LF にしてください)`)
  const notes = text.trim()
  if (!notes) fail(`docs/releases/${version}.txt が空です`)
  if (notes.length > NOTES_LIMIT) fail(`docs/releases/${version}.txt が長すぎます(${notes.length} 字。${NOTES_LIMIT} 字まで)`)
  for (const [i, line] of notes.split('\n').entries()) {
    // リリースのページ(Markdown)では、見出し・リンク・強調・表・引用・通知・issue へのリンクになる記号
    if (/[#@`<>[\]|*_&\\]/.test(line) || /^\s*([-=])\1{2,}\s*$/.test(line)) {
      fail(`docs/releases/${version}.txt の ${i + 1} 行目に、リリースのページで見た目が変わる記号があります` +
        '(# @ ` < > [ ] | * _ & \\ と、- や = だけの行は使えません)')
    }
  }
  return notes
}

export function check(tag, root = repoRoot) {
  const match = TAG_RE.exec(tag ?? '')
  if (!match) fail(`タグは v<版>(例 v0.1.9)にしてください: ${tag}`)
  const version = match[1]
  const pkg = readJson(path.join(root, 'package.json')).version
  if (pkg !== version) fail(`タグの版 ${version} と package.json の版 ${pkg} が違います`)
  const lock = readJson(path.join(root, 'package-lock.json'))
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    fail(`package-lock.json の版が ${version} ではありません(npm version ${version} --no-git-tag-version で上げてください)`)
  }
  return {version, notes: readNotes(version, root)}
}

// ---- bundle(build ジョブ) ----

export function bundle(tag, outDir, {root = repoRoot, app = path.join(repoRoot, 'release/mac-arm64', APP_NAME),
  dmgDir = path.join(repoRoot, 'release')} = {}) {
  const {version, notes} = check(tag, root)
  const keys = publicKeys(root)
  if (keys.length === 0) fail('src/main/updateKey.ts に公開鍵がありません(docs/release.md の 1. を先に済ませてください)')
  if (!existsSync(app)) fail(`${app} がありません(npm run package を先に流してください)`)
  const info = readPlist(path.join(app, 'Contents/Info.plist'))
  if (info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleShortVersionString !== version) {
    fail(`アプリの名札か版が違います(${info.CFBundleIdentifier} ${info.CFBundleShortVersionString})`)
  }
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], {stdio: 'pipe'})
  } catch (error) {
    fail(`アプリの署名が壊れています: ${String(error.stderr ?? error.message).trim()}`)
  }
  if (execFileSync('/usr/bin/xattr', ['-lr', app], {encoding: 'utf8', maxBuffer: 64 << 20}).includes('com.apple.quarantine')) {
    fail('アプリにネットから来た印(com.apple.quarantine)が付いています')
  }
  // asar は圧縮しないので、バイト列で探せる。検査用の版が紛れ込んでいないこと、公開鍵が updateKey.ts と同じこと
  const asar = readFileSync(path.join(app, 'Contents/Resources/app.asar'))
  if (asar.includes(TEST_MARKER)) fail('検査用の版(--update-test で作ったもの)です。npm run package で作り直してください')
  for (const key of keys) {
    if (!asar.includes(key)) fail(`アプリに公開鍵 ${key} が入っていません(src/main/updateKey.ts を変えた後に作り直してください)`)
  }

  if (existsSync(outDir) && readdirSync(outDir).length > 0) fail(`出力先が空ではありません: ${outDir}`)
  mkdirSync(outDir, {recursive: true})
  const zip = path.join(outDir, zipName(version))
  // Electron の Framework の symlink を保つため、ditto で作る
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip])
  const names = execFileSync('/usr/bin/zipinfo', ['-1', zip], {encoding: 'utf8', maxBuffer: 64 << 20}).split('\n').filter(Boolean)
  // 英数字でない名前は、Finder で取り出すと正規化が変わって署名から外れることがある(ryukyu-yayoi の教訓)
  if (names.some((name) => /[^\x20-\x7e]/.test(name))) fail('zip の中に英数字でない名前があります')
  const tops = new Set(names.map((name) => name.split('/')[0]))
  tops.delete('__MACOSX')
  if (tops.size !== 1 || !tops.has(APP_NAME)) fail(`zip の一番上が ${APP_NAME} だけではありません: ${[...tops].join(', ')}`)
  const dmg = path.join(dmgDir, dmgName(version))
  if (!existsSync(dmg)) fail(`${dmg} がありません`)
  copyFileSync(dmg, path.join(outDir, dmgName(version)))
  const size = statSync(zip).size
  const sha256 = fileSha256(zip)
  writeFileSync(path.join(outDir, 'release.json'), `${JSON.stringify({
    version, file: zipName(version), size, sha256, url: `${DOWNLOAD_PREFIX}v${version}/${zipName(version)}`,
  }, null, 2)}\n`)
  console.log(`版 ${version}: ${zipName(version)}(${size} バイト)と ${dmgName(version)} を ${outDir} に作りました`)
  return {version, notes, size, sha256}
}

// ---- sign(sign ジョブ) ----

function releaseBody(version, notes) {
  return `${notes}

## 手で入れるとき

1. Claude Term を終了します。
2. \`${dmgName(version)}\` を開き、Claude Term.app を「アプリケーション」フォルダへ入れ替えます。
3. Apple の開発者の署名をしていない(ad-hoc 署名の)ため、初回は次を実行してから起動します。

   \`\`\`sh
   xattr -cr "/Applications/Claude Term.app"
   \`\`\`

0.1.9 以降を入れている Mac では、起動したときに「アップデートのお知らせ」が出て、［今すぐ更新］で入れ替わります。
起動したときに、GitHub へ更新の情報(latest-mac.json)を 1 回取りに行きます。
`
}

export function signRelease(tag, dir, {root = repoRoot, key = process.env.UPDATE_SIGNING_KEY, now = new Date()} = {}) {
  // 鍵の値はどこにも出さない。読んだら環境変数から消す(後に動くものへ渡さない)
  delete process.env.UPDATE_SIGNING_KEY
  const {version, notes} = check(tag, root)
  const seed = Buffer.from(String(key ?? '').trim(), 'base64')
  if (seed.length !== 32) fail('秘密鍵(環境変数 UPDATE_SIGNING_KEY)がないか、形が違います')
  const zip = path.join(dir, zipName(version))
  if (!existsSync(zip)) fail(`${zip} がありません`)
  // build ジョブの artifact を信じきらず、ここで計算し直す
  const size = statSync(zip).size
  const sha256 = fileSha256(zip)
  const built = readJson(path.join(dir, 'release.json'))
  if (built.version !== version || built.size !== size || built.sha256 !== sha256) {
    fail('zip が build ジョブで作ったものと違います')
  }
  const message = signedMessage(version, sha256, size, notes)
  const privateKey = createPrivateKey({key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8'})
  const signature = sign(null, message, privateKey).toString('base64')
  if (!verifyWith(publicKeys(root), message, signature)) {
    fail('署名を src/main/updateKey.ts の公開鍵で確かめられません。Secrets の秘密鍵と公開鍵が組になっているか確かめてください')
  }
  const latest = {
    version,
    notes,
    pub_date: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    url: `${DOWNLOAD_PREFIX}v${version}/${zipName(version)}`,
    sha256,
    size,
    signature,
  }
  writeFileSync(path.join(dir, 'latest-mac.json'), `${JSON.stringify(latest, null, 2)}\n`)
  writeFileSync(path.join(dir, 'notes.md'), releaseBody(version, notes))
  rmSync(path.join(dir, 'release.json'), {force: true})
  console.log(`版 ${version}: ${zipName(version)} に署名し、latest-mac.json と notes.md を作りました`)
  return latest
}

// ---- verify ----

export function verifyLatest(latestFile, zip, {root = repoRoot, keys = publicKeys(root)} = {}) {
  const info = readJson(latestFile)
  const {version, notes, url, sha256, size, signature} = info
  if (typeof version !== 'string' || !VERSION_RE.test(version)) fail('version の形が違います')
  if (typeof notes !== 'string') fail('notes がありません')
  if (url !== `${DOWNLOAD_PREFIX}v${version}/${zipName(version)}`) fail(`url が違います: ${url}`)
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) fail('sha256 の形が違います')
  if (!Number.isSafeInteger(size) || size < 1) fail('size の形が違います')
  if (typeof signature !== 'string' || !verifyWith(keys, signedMessage(version, sha256, size, notes), signature)) {
    fail('署名が合いません')
  }
  if (zip) {
    if (statSync(zip).size !== size) fail('zip の大きさが latest-mac.json と違います')
    if (fileSha256(zip) !== sha256) fail('zip の SHA-256 が latest-mac.json と違います')
  }
  console.log(`版 ${version}: 署名 OK${zip ? '、zip OK' : ''}`)
  return info
}

// ---- keygen ----

function insideGitWorkTree(dir) {
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

export function keygen(file) {
  if (!file) fail('使い方: keygen <秘密鍵のファイル>(例 ~/.claude-term-release/update.key)')
  const target = path.resolve(file)
  const dir = path.dirname(target)
  if (target.startsWith(repoRoot + path.sep)) fail('秘密鍵はリポジトリの外に作ってください')
  if (existsSync(target)) fail(`秘密鍵のファイルがすでにあります(作り直すと、配った版は自動で更新できなくなります): ${target}`)
  mkdirSync(dir, {recursive: true, mode: 0o700})
  if (insideGitWorkTree(dir)) fail('秘密鍵は git の作業ツリーの外に作ってください')
  const {privateKey} = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({format: 'jwk'})
  const seed = Buffer.from(jwk.d, 'base64url').toString('base64')
  const pub = Buffer.from(jwk.x, 'base64url').toString('base64')
  // 改行を付けない(gh secret set < ファイル でそのまま入れるため)
  writeFileSync(target, seed, {mode: 0o600, flag: 'wx'})
  writeFileSync(`${target}.pub`, `${pub}\n`, {mode: 0o644, flag: 'wx'})
  console.log(`秘密鍵: ${target}(本人だけが読める権限 600)`)
  console.log(`公開鍵: ${pub}`)
  console.log('公開鍵を src/main/updateKey.ts の UPDATE_PUBLIC_KEYS に書いてください(docs/release.md の 1.1)')
  return pub
}

// ---- 入口 ----

function main(argv) {
  const [command, ...args] = argv
  if (command === 'check') {
    const {version} = check(args[0])
    console.log(`版 ${version}: タグ・package.json・package-lock.json・変更の内容 OK`)
  } else if (command === 'bundle') {
    if (!args[1]) fail('使い方: bundle <タグ> <出力フォルダ>')
    bundle(args[0], path.resolve(args[1]))
  } else if (command === 'sign') {
    if (!args[1]) fail('使い方: sign <タグ> <フォルダ>')
    signRelease(args[0], path.resolve(args[1]))
  } else if (command === 'verify') {
    if (!args[0]) fail('使い方: verify <latest-mac.json> [zip]')
    verifyLatest(args[0], args[1])
  } else if (command === 'keygen') {
    keygen(args[0])
  } else {
    fail('使い方: check <タグ> | bundle <タグ> <出力> | sign <タグ> <フォルダ> | verify <latest-mac.json> [zip] | keygen <ファイル>')
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    if (!(error instanceof ReleaseError)) throw error
    console.error(`リリースできません: ${error.message}`)
    process.exit(1)
  }
}
