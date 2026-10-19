import {execFile, spawn} from 'node:child_process'
import {createHash, createPublicKey, verify} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {UpdateErrorCode} from '../shared/types'

// アプリの更新のうち、Electron に依存しない部分(確かめ・ダウンロード・展開・入れ替え)。
// 形は ryukyu-yayoi(Mac・ad-hoc 署名・自前の更新)の update.swift / release.py にそろえる。
// 署名する文字列は scripts/release.mjs と同じにする

export const RELEASE_REPO = 'mtenma/claude-term'
export const FEED_URL = `https://github.com/${RELEASE_REPO}/releases/latest/download/latest-mac.json`
export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`
export const DOWNLOAD_PREFIX = `https://github.com/${RELEASE_REPO}/releases/download/`
const MANIFEST_LIMIT = 64 * 1024
const MAX_ZIP_SIZE = 1_000_000_000
const MAX_NOTES = 10_000

export class UpdateError extends Error {
  constructor(readonly code: UpdateErrorCode | 'cancelled', message: string = code) {
    super(message)
  }
}

export interface UpdateRelease {
  version: string
  notes: string
  url: string
  sha256: string
  size: number
}

// 各桁 0〜999999、先頭の 0 は不可(0.1.09 や桁あふれを通さない)
const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/

export function versionParts(text: string): number[] | null {
  const match = VERSION_RE.exec(text)
  return match ? match.slice(1).map(Number) : null
}

/** a が b より新しいか。どちらかの形が違えば false */
export function isNewer(a: string, b: string): boolean {
  const x = versionParts(a)
  const y = versionParts(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i]
  }
  return false
}

export const zipName = (version: string): string => `Claude-Term-${version}-arm64-mac.zip`

const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')

/** 署名する中身。変更の内容も、書き換えられると通らない。url は入れない(zip は SHA-256 で確かめる) */
export function signedMessage(version: string, sha256: string, size: number, notes: string): Buffer {
  return Buffer.from(`claude-term-update-v1\n${version}\n${sha256}\n${size}\n${sha256Hex(notes)}\n`, 'utf8')
}

const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/
const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/

export function verifySignature(publicKeys: readonly string[], message: Buffer, signature: string): boolean {
  if (!SIGNATURE_RE.test(signature)) return false
  const sig = Buffer.from(signature, 'base64')
  return publicKeys.some((key) => {
    if (!PUBLIC_KEY_RE.test(key)) return false
    const x = Buffer.from(key, 'base64').toString('base64url')
    return verify(null, message, createPublicKey({key: {kty: 'OKP', crv: 'Ed25519', x}, format: 'jwk'}), sig)
  })
}

export interface ReleaseCheck {
  publicKeys: readonly string[]
  /** zip の URL の土台。版とファイル名を足したものと完全に一致することを求める */
  downloadPrefix: string
}

/** 形と署名が正しいときだけ返す。合わなければ理由を投げる(お知らせは出さない) */
export function parseRelease(text: string, check: ReleaseCheck): UpdateRelease {
  let info: Record<string, unknown>
  try {
    info = JSON.parse(text) as Record<string, unknown>
  } catch {
    throw new Error('latest-mac.json is not JSON')
  }
  const {version, notes, url, sha256, size, signature} = info ?? {}
  if (typeof version !== 'string' || !versionParts(version)) throw new Error('invalid version')
  if (typeof notes !== 'string' || notes.length > MAX_NOTES) throw new Error('invalid notes')
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error('invalid sha256')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || size > MAX_ZIP_SIZE) {
    throw new Error('invalid size')
  }
  if (url !== `${check.downloadPrefix}v${version}/${zipName(version)}`) throw new Error('invalid url')
  if (typeof signature !== 'string' ||
    !verifySignature(check.publicKeys, signedMessage(version, sha256, size, notes), signature)) {
    throw new Error('invalid signature')
  }
  return {version, notes, url, sha256, size}
}

export type FetchLike = (url: string, init: {signal: AbortSignal}) => Promise<Response>

/** 本文を上限まで読む(Content-Length が無くても、読みながら数えて止める) */
async function readLimited(res: Response, limit: number): Promise<Buffer> {
  const declared = res.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) throw new Error('response too large')
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new Error('response too large')
    }
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}

/** 更新情報を取る。まだ置かれていない(404)なら null */
export async function fetchRelease(fetchFn: FetchLike, feedUrl: string, check: ReleaseCheck,
  timeoutMs: number): Promise<UpdateRelease | null> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetchFn(feedUrl, {signal: ctl.signal})
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`)
    return parseRelease((await readLimited(res, MANIFEST_LIMIT)).toString('utf8'), check)
  } finally {
    clearTimeout(timer)
  }
}

export interface DownloadOptions {
  /** この時間、1 バイトも届かなければ止める(全体の時間の上限は設けない。遅い回線でも終われるように) */
  stallMs: number
  signal: AbortSignal
  onProgress: (received: number) => void
}

/** zip を dest に書く。大きさと SHA-256 は読みながら確かめ、size を超えたらその場で止める */
export async function downloadZip(fetchFn: FetchLike, release: UpdateRelease, dest: string,
  opts: DownloadOptions): Promise<void> {
  // 中止済みの signal には abort の知らせが来ないので、始める前に見る
  if (opts.signal.aborted) throw new UpdateError('cancelled')
  const ctl = new AbortController()
  const abort = () => ctl.abort()
  opts.signal.addEventListener('abort', abort)
  let stalled = false
  let timer: NodeJS.Timeout | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = true
      ctl.abort()
    }, opts.stallMs)
  }
  let file: fs.promises.FileHandle | null = null
  try {
    arm()
    const res = await fetchFn(release.url, {signal: ctl.signal})
    if (res.status !== 200 || !res.body) throw new UpdateError('network', `HTTP ${res.status}`)
    const declared = res.headers.get('content-length')
    if (declared !== null && Number(declared) !== release.size) throw new UpdateError('corrupt', 'content-length differs')
    file = await fs.promises.open(dest, 'wx', 0o600)
    const hash = createHash('sha256')
    let received = 0
    const reader = res.body.getReader()
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      arm()
      received += value.byteLength
      if (received > release.size) throw new UpdateError('corrupt', 'longer than size')
      hash.update(value)
      await file.write(value)
      opts.onProgress(received)
    }
    if (received !== release.size) throw new UpdateError('corrupt', 'shorter than size')
    if (hash.digest('hex') !== release.sha256) throw new UpdateError('corrupt', 'sha256 differs')
  } catch (error) {
    if (error instanceof UpdateError) throw error
    if (opts.signal.aborted) throw new UpdateError('cancelled')
    throw new UpdateError('network', stalled ? 'stalled' : String(error))
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', abort)
    ctl.abort()
    await file?.close()
  }
}

/** 動いている実行ファイルから .app を求める(symlink 越しに開いた場合も実体の場所にする) */
export function appBundleOf(exePath: string): string {
  return path.resolve(fs.realpathSync(exePath), '../../..')
}

/**
 * 入れ替えられる置き場所かを、ダウンロードの前に確かめる。
 * DMG(読み取り専用)・ダウンロードした場所(App Translocation)・別のボリューム・書き込めない場所を断る
 */
export function checkInstallable(appPath: string, updatesDir: string): void {
  const fail = () => new UpdateError('location', appPath)
  if (!appPath.endsWith('.app') || appPath.includes('/AppTranslocation/')) throw fail()
  try {
    fs.accessSync(appPath, fs.constants.W_OK)
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK)
  } catch {
    throw fail()
  }
  // 試しの rename: userData からアプリの隣へ名前を移せるか。EXDEV(別のボリューム)・EACCES・EPERM・EROFS をまとめて見る
  fs.mkdirSync(updatesDir, {recursive: true, mode: 0o700})
  const probe = fs.mkdtempSync(path.join(updatesDir, 'probe-'))
  const beside = path.join(path.dirname(appPath), `.claude-term-${path.basename(probe)}`)
  try {
    fs.renameSync(probe, beside)
    fs.renameSync(beside, probe)
  } catch (error) {
    // アプリケーションフォルダに置いていても、ユーザーデータと別のディスクなら入れ替えられない(案内の文を分ける)
    if ((error as NodeJS.ErrnoException).code === 'EXDEV') throw new UpdateError('other_volume', appPath)
    throw fail()
  } finally {
    for (const dir of [beside, probe]) {
      try {
        fs.rmdirSync(dir)
      } catch {
        // 無ければよい
      }
    }
  }
}

/**
 * `ps -axo pid=,args=` の出力から、同じ実行ファイルで動いているほかの Claude Term を探す。
 * Codex の hook の中継(ELECTRON_RUN_AS_NODE で同じ実行ファイルを一瞬動かす)は数えない
 */
export function otherInstances(psOutput: string, exePath: string, selfPid: number): number[] {
  const pids: number[] = []
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const args = match[2]
    if (pid === selfPid || !args.startsWith(exePath)) continue
    if (args.length > exePath.length && args[exePath.length] !== ' ') continue
    if (args.includes('codexHookRelay')) continue
    pids.push(pid)
  }
  return pids
}

/** zip と展開した .app が置けるだけの空きがあるか(zip の約 3.4 倍を使うので 4 倍を求める) */
export function checkDiskSpace(dir: string, size: number): void {
  const stat = fs.statfsSync(dir)
  const need = size * 4
  if (stat.bavail * stat.bsize < need) throw new UpdateError('disk_space', String(Math.ceil(need / 1_000_000)))
}

export function runTool(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, {maxBuffer: 16 << 20}, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(file)}: ${String(stderr).trim() || error.message}`))
      else resolve(String(stdout))
    })
  })
}

export interface AppIdentity {
  /** zip の中の .app の名前(例: Claude Term.app) */
  appName: string
  bundleId: string
}

/** zip を空のフォルダへ展開し、中のアプリの名札・版・署名を確かめる。確かめ済みの .app のパスを返す */
export async function extractApp(zip: string, workDir: string, release: UpdateRelease,
  identity: AppIdentity): Promise<string> {
  const invalid = (detail: string) => new UpdateError('invalid_app', detail)
  const out = fs.mkdtempSync(path.join(workDir, 'new-'))
  try {
    await runTool('/usr/bin/ditto', ['-x', '-k', zip, out])
  } catch (error) {
    throw invalid(String(error))
  }
  const entries = fs.readdirSync(out)
  if (entries.length !== 1 || entries[0] !== identity.appName) throw invalid(`entries: ${entries.join(', ')}`)
  const app = path.join(out, identity.appName)
  if (!fs.lstatSync(app).isDirectory()) throw invalid('not a directory')
  let info: Record<string, unknown>
  try {
    info = JSON.parse(await runTool('/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', path.join(app, 'Contents/Info.plist')])) as Record<string, unknown>
  } catch (error) {
    throw invalid(String(error))
  }
  if (info.CFBundleIdentifier !== identity.bundleId || info.CFBundleShortVersionString !== release.version) {
    throw invalid(`${String(info.CFBundleIdentifier)} ${String(info.CFBundleShortVersionString)}`)
  }
  try {
    // zip にネットから来た印が付いていると、展開物すべてに移り、Gatekeeper に止められる。中身は署名で確かめ済み
    await runTool('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', app])
    // 展開で壊れていないこと(本物かどうかは Ed25519 の署名と SHA-256 で確かめている)
    await runTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  } catch (error) {
    throw invalid(String(error))
  }
  return app
}

export type SwapResult = {ok: true} | {ok: false; restored: boolean; reason: string}

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? String(error)

/**
 * 今の .app を退避先へ移し、新しい .app を今の場所へ移す。rename(2) なので、行き先があれば中へ入れずに断り
 * (ENOTEMPTY)、別のボリュームなら何も動かさない(EXDEV)。2 つ目に失敗したら 1 つ目を戻す
 */
export function swapApp(current: string, next: string, backup: string): SwapResult {
  try {
    fs.lstatSync(backup)
    return {ok: false, restored: true, reason: 'backup exists'}
  } catch {
    // 無いことを確かめた
  }
  try {
    fs.mkdirSync(path.dirname(backup), {recursive: true, mode: 0o700})
    fs.renameSync(current, backup)
  } catch (error) {
    return {ok: false, restored: true, reason: errorCode(error)}
  }
  try {
    fs.renameSync(next, current)
    return {ok: true}
  } catch (error) {
    const reason = errorCode(error)
    try {
      fs.renameSync(backup, current)
      return {ok: false, restored: true, reason}
    } catch {
      return {ok: false, restored: false, reason}
    }
  }
}

// アプリの終了を待ってから開き直す。パスは引数で渡し、スクリプトの文字列に埋め込まない
const RELAUNCH_SCRIPT = [
  'i=0; while /bin/kill -0 "$1" 2>/dev/null && [ $i -lt 300 ]; do /bin/sleep 0.2; i=$((i+1)); done',
  // pid が消えても、LaunchServices がまだ起動中と見ている間に open すると、開き直さないことがある
  'i=0; while [ -n "$(/usr/bin/lsappinfo find bundleid="$3" 2>/dev/null)" ] && [ $i -lt 50 ]; do' +
  ' /bin/sleep 0.2; i=$((i+1)); done',
  'if [ -n "$4" ]; then exec "$4"; else exec /usr/bin/open "$2"; fi',
].join('\n')

export interface RelaunchOptions {
  pid: number
  app: string
  bundleId: string
  /** 検査用: open の代わりに直接起動する実行ファイル(LaunchServices と TCC の確認を通らない) */
  executable?: string
  env?: NodeJS.ProcessEnv
}

/** 切り離した sh を起動する。起動できたことを確かめてから返す */
export function spawnRelaunch(opts: RelaunchOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh',
      ['-c', RELAUNCH_SCRIPT, 'sh', String(opts.pid), opts.app, opts.bundleId, opts.executable ?? ''], {
        detached: true,
        stdio: 'ignore',
        env: opts.env ?? {PATH: '/usr/bin:/bin'},
      })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

// ---- 次の起動での成否 ----

export interface PendingUpdate {
  from: string
  to: string
  at: number
  /** 入れ替えに失敗したとき(swap_failed: 元に戻した、stranded: 元の場所に戻せなかった) */
  failure?: 'swap_failed' | 'stranded'
}

const PENDING_FILE = 'pending.json'

/** 一時ファイルに書いてから名前を付け替える(途中まで書かれたものを読まないため) */
export function writePending(dir: string, pending: PendingUpdate): void {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  const tmp = path.join(dir, `${PENDING_FILE}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(pending), {mode: 0o600})
  fs.renameSync(tmp, path.join(dir, PENDING_FILE))
}

export function readPending(dir: string): PendingUpdate | 'broken' | null {
  let text: string
  try {
    text = fs.readFileSync(path.join(dir, PENDING_FILE), 'utf8')
  } catch {
    return null
  }
  try {
    const p = JSON.parse(text) as Partial<PendingUpdate>
    if (typeof p.from === 'string' && versionParts(p.from) && typeof p.to === 'string' && versionParts(p.to)) {
      const failure = p.failure === 'swap_failed' || p.failure === 'stranded' ? p.failure : undefined
      return {from: p.from, to: p.to, at: Number(p.at) || 0, failure}
    }
  } catch {
    // 下で broken
  }
  return 'broken'
}

export function removePending(dir: string): void {
  fs.rmSync(path.join(dir, PENDING_FILE), {force: true})
}

/** updates/ を片付ける。動いているアプリがこの中にある(元の場所に戻せなかった)ときは消さない */
export function cleanUpdates(dir: string, runningApp: string): boolean {
  if (runningApp.startsWith(dir + path.sep)) return false
  fs.rmSync(dir, {recursive: true, force: true})
  return true
}
