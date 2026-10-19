import {app, BrowserWindow, dialog, ipcMain, session, shell, type IpcMainEvent, type IpcMainInvokeEvent,
  type Session} from 'electron'
import {execFile, execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CH, type AppearanceSettings, type UpdateFailure, type UpdateView} from '../shared/types'
import {getAppearance} from './settings'
import {UPDATE_PUBLIC_KEYS} from './updateKey'
import {
  DOWNLOAD_PREFIX, FEED_URL, RELEASES_PAGE, UpdateError, appBundleOf, checkDiskSpace, checkInstallable, cleanUpdates,
  downloadZip, extractApp, fetchRelease, isNewer, otherInstances, readPending, removePending, spawnRelaunch,
  swapApp, writePending, type AppIdentity, type FetchLike, type UpdateRelease,
} from './updateCore'

// アプリの更新: 起動時に 1 回だけ新しい版を確かめ、あればお知らせの窓を出す。
// ［今すぐ更新］でダウンロード・確かめ・展開まで済ませてから終了し、終了の直前(will-quit)に入れ替えて開き直す。
// 設計は claudedocs/app-update-design.md、リリースの手順は docs/release.md

const CHECK_DELAY_MS = 5_000
const CHECK_TIMEOUT_MS = 20_000
const STALL_MS = 30_000
/** app.quit() から will-quit までの見張り。来なければ終了が取り消されたとみなす */
const QUIT_WATCH_MS = 10_000

const PRODUCTION: AppIdentity = {appName: 'Claude Term.app', bundleId: 'jp.sabira.claude-term'}

/** 検査用の版だけに埋め込む設定(scripts/build.mjs --update-test)。配る版では null */
interface UpdateTestConfig {
  bundleId: string
  appName: string
  feedUrl: string
  downloadPrefix: string
  publicKeys: string[]
  userData: string
  checkDelayMs: number
  /** お知らせを出したら自動で［今すぐ更新］を押す */
  autoStart: boolean
  /** 前回の更新の結果を resultFile に書いて終わる(入れ替わった後の版の確かめ) */
  resultFile: string
  /** open を通さず実行ファイルを直接起動する(LaunchServices と TCC の確認を通らない) */
  directRelaunch: boolean
}
declare const __CLAUDE_TERM_UPDATE_TEST__: UpdateTestConfig | null

/** 検査用の設定は、検査用の bundle ID で作ったパッケージでだけ使う(普段の版に紛れ込んでも効かない) */
function loadTestConfig(): UpdateTestConfig | null {
  const config = __CLAUDE_TERM_UPDATE_TEST__
  if (!config || !app.isPackaged || config.bundleId === PRODUCTION.bundleId) return null
  try {
    const plist = path.join(appBundleOf(process.execPath), 'Contents/Info.plist')
    const id = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist],
      {encoding: 'utf8'}).trim()
    return id === config.bundleId ? config : null
  } catch {
    return null
  }
}
const testConfig = loadTestConfig()

/** 検査用の版は userData を分ける。app の ready より前、ほかのモジュールが userData を使う前に呼ぶ */
export function applyUpdateTestPaths(): void {
  if (testConfig) app.setPath('userData', testConfig.userData)
}

/** 検査用の版では hooks の確認(同意のダイアログと ~/.claude・~/.codex の書き換え)をしない */
export const isUpdateTestBuild = (): boolean => testConfig !== null

interface Hooks {
  /** 全部の窓の、終了していないセッションの数 */
  liveSessions: () => number
  /** 「実行中のセッションがあります」の確認を省き、app.quit() で閉じられるようにする */
  allowQuit: () => void
}

interface QuitPlan {
  current: string
  next: string
  backup: string
  from: string
  to: string
}

let hooks: Hooks | null = null
let release: UpdateRelease | null = null
let view: UpdateView | null = null
let win: BrowserWindow | null = null
let job: AbortController | null = null
let quitPlan: QuitPlan | null = null
let quitWatch: NodeJS.Timeout | null = null
/** ⌘Q などで、処理中でも窓を閉じてよいとき */
let allowClose = false
let updateSession: Session | null = null

const identity = (): AppIdentity => testConfig ?? PRODUCTION
const updatesDir = (): string => path.join(app.getPath('userData'), 'updates')
const shotMode = (): boolean => Boolean(process.env.CLAUDE_TERM_SCREENSHOT)
const busy = (): boolean => view !== null && ['preparing', 'downloading', 'verifying', 'quitting'].includes(view.phase)
const tildify = (file: string): string =>
  file === os.homedir() || file.startsWith(`${os.homedir()}/`) ? `~${file.slice(os.homedir().length)}` : file
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * 更新専用の、保存しない session。GitHub が付ける cookie(_octo など)を保存して次の起動で送ったり、
 * 大きな zip を HTTP のキャッシュに残したりしない。User-Agent に版を入れない
 */
const updateFetch: FetchLike = (url, init) => {
  if (!updateSession) {
    updateSession = session.fromPartition('claude-term-update')
    updateSession.setUserAgent('ClaudeTerm-Updater')
  }
  return updateSession.fetch(url, {...init, credentials: 'omit', cache: 'no-store'}) as Promise<Response>
}

/** --update-feed <URL>: プレリリースを試す用。このリポジトリのリリースの下だけを受け付ける(署名は必ず確かめる) */
function feedUrl(): string {
  if (testConfig) return testConfig.feedUrl
  const at = process.argv.indexOf('--update-feed')
  const value = at >= 0 ? process.argv[at + 1] : undefined
  return value?.startsWith(`${RELEASES_PAGE}/`) ? value : FEED_URL
}

const releaseCheck = () => ({
  publicKeys: testConfig?.publicKeys ?? UPDATE_PUBLIC_KEYS,
  downloadPrefix: testConfig?.downloadPrefix ?? DOWNLOAD_PREFIX,
})

// ---- 起動時 ----

/** 前回の更新の後片付け。予約した版で起動していなければ、その理由を返す */
function settlePreviousUpdate(): {had: boolean; failure: UpdateFailure | null} {
  const dir = updatesDir()
  const pending = readPending(dir)
  let failure: UpdateFailure | null = null
  if (pending === 'broken') failure = 'unknown'
  else if (pending && isNewer(pending.to, app.getVersion())) failure = pending.failure ?? 'unknown'
  const running = appBundleOf(process.execPath)
  if (!cleanUpdates(dir, running)) {
    // 入れ替えに失敗して元の場所にも戻せず、退避した場所から開いている
    removePending(dir)
    failure = 'stranded'
  }
  return {had: pending !== null, failure}
}

export function startAppUpdates(h: Hooks): void {
  hooks = h
  if (!app.isPackaged || shotMode()) return
  let previous: ReturnType<typeof settlePreviousUpdate>
  try {
    previous = settlePreviousUpdate()
  } catch (error) {
    console.warn('[update] 前回の更新の後片付けに失敗しました:', message(error))
    previous = {had: false, failure: null}
  }
  if (testConfig && previous.had) {
    // 入れ替わった後の版: 結果を書いて終わる
    fs.writeFileSync(testConfig.resultFile, JSON.stringify({version: app.getVersion(), failure: previous.failure}))
    setTimeout(() => app.quit(), 500)
    return
  }
  if (previous.failure === 'stranded') {
    void dialog.showMessageBox({
      type: 'warning',
      message: 'Claude Term を元の場所に戻せませんでした',
      detail: `前回の更新で入れ替えに失敗しました。今は ${tildify(appBundleOf(process.execPath))} から開いています。` +
        'Claude Term を終了してから、Finder でこのアプリを「アプリケーション」フォルダへ移してください。',
    })
    return
  }
  if (releaseCheck().publicKeys.length === 0) return
  setTimeout(() => void checkOnce(previous.failure), testConfig?.checkDelayMs ?? CHECK_DELAY_MS)
}

async function checkOnce(previousFailure: UpdateFailure | null): Promise<void> {
  try {
    const found = await fetchRelease(updateFetch, feedUrl(), releaseCheck(), CHECK_TIMEOUT_MS)
    if (found && isNewer(found.version, app.getVersion())) {
      release = found
      view = {
        phase: 'ready', version: found.version, current: app.getVersion(), notes: found.notes,
        sessions: hooks?.liveSessions() ?? 0, received: 0, total: found.size, error: null, errorDetail: '',
        previousFailure,
      }
      openWindow()
      return
    }
  } catch (error) {
    // 届かない・形が違う・署名が合わないときは何も出さない(ターミナルの操作を止めない)
    console.warn('[update] 新しい版を確かめられませんでした:', message(error))
  }
  if (previousFailure) {
    void dialog.showMessageBox({
      type: 'warning',
      message: '前回の更新はできませんでした',
      detail: '今のバージョンのまま開いています。次に起動したときに、もう一度お知らせします。',
    })
  }
}

// ---- お知らせの窓 ----

function send(): void {
  if (win && !win.isDestroyed() && view) win.webContents.send(CH.updateView, view)
}

function setView(patch: Partial<UpdateView>): void {
  if (!view) return
  view = {...view, ...patch}
  if (win && !win.isDestroyed()) {
    win.setClosable(!busy() || allowClose || quitPlan !== null)
    win.setProgressBar(view.phase === 'downloading' && view.total > 0 ? view.received / view.total
      : busy() ? 2 : -1)
  }
  send()
}

function openWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  const appearance = getAppearance()
  // ターミナルで打っている最中に、キー入力を奪わないように前に出すだけにする
  const terminal = BrowserWindow.getFocusedWindow()
  const created = new BrowserWindow({
    width: 520,
    height: 460,
    minWidth: 480,
    minHeight: 400,
    title: 'アップデート — Claude Term',
    backgroundColor: appearance.background,
    show: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/updatePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win = created
  if (terminal && !terminal.isDestroyed()) {
    // 焦点のあるターミナルの窓と同じ画面の中央に出す
    const t = terminal.getBounds()
    const [w, h] = created.getSize()
    created.setPosition(Math.round(t.x + (t.width - w) / 2), Math.round(t.y + (t.height - h) / 2))
  }
  created.once('ready-to-show', () => {
    if (terminal && !terminal.isDestroyed() && terminal.isFocused() && !testConfig) created.showInactive()
    else created.show()
    if (testConfig?.autoStart) void start()
  })
  created.on('close', (e) => {
    if (busy() && !allowClose && quitPlan === null) e.preventDefault()
  })
  created.on('closed', () => {
    if (win === created) win = null
    // 処理中に窓が無くなった(⌘Q など)ら、ダウンロードをやめる
    if (quitPlan === null) job?.abort()
  })
  void created.loadFile(path.join(__dirname, '../renderer/update.html'))
  return created
}

export function sendAppearanceToUpdateWindow(appearance: AppearanceSettings): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.settingsUpdate, appearance)
}

export function notifySessionsChanged(): void {
  if (view && hooks && win && !win.isDestroyed()) {
    const sessions = hooks.liveSessions()
    if (sessions !== view.sessions) setView({sessions})
  }
}

// ---- ［今すぐ更新］ ----

function listProcesses(): Promise<string> {
  return new Promise((resolve, reject) => {
    // 日本語を含むパスを ps が別の形で出さないように、UTF-8 の locale で動かす
    execFile('/bin/ps', ['-axo', 'pid=,args='], {env: {LC_ALL: 'en_US.UTF-8', PATH: '/usr/bin:/bin'},
      maxBuffer: 16 << 20}, (error, stdout) => error ? reject(error) : resolve(String(stdout)))
  })
}

/** ほかに同じ実行ファイルの Claude Term が動いていれば断る(入れ替えると、そちらが壊れる) */
async function ensureNoOtherInstance(): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (otherInstances(await listProcesses(), process.execPath, process.pid).length === 0) return
    // Codex の hook の中継と取り違えないよう、少しおいて見直す
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new UpdateError('other_instance')
}

async function start(): Promise<void> {
  if (!release || !view || busy() || shotMode()) return
  const target = release
  const ctl = new AbortController()
  job = ctl
  allowClose = false
  setView({phase: 'preparing', error: null, errorDetail: '', received: 0})
  const dir = path.join(updatesDir(), target.version)
  try {
    const current = appBundleOf(process.execPath)
    checkInstallable(current, updatesDir())
    await ensureNoOtherInstance()
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true, mode: 0o700})
    checkDiskSpace(dir, target.size)
    setView({phase: 'downloading'})
    const zip = path.join(dir, 'download.zip')
    let shown = 0
    await downloadZip(updateFetch, target, zip, {
      stallMs: STALL_MS,
      signal: ctl.signal,
      onProgress: (received) => {
        // 画面への通知は 512KB ごと(1 バイトごとに IPC を送らない)
        if (received - shown >= 512 * 1024 || received === target.size) {
          shown = received
          setView({received})
        }
      },
    })
    setView({phase: 'verifying'})
    const next = await extractApp(zip, dir, target, identity())
    fs.rmSync(zip, {force: true})
    if (ctl.signal.aborted) throw new UpdateError('cancelled')
    // ダウンロードの間に状況が変わっていないか、終了の前にもう一度確かめる
    checkInstallable(current, updatesDir())
    await ensureNoOtherInstance()
    beginQuit({
      current, next, backup: path.join(dir, 'previous', path.basename(current)),
      from: app.getVersion(), to: target.version,
    })
  } catch (error) {
    if (job === ctl) job = null
    fs.rmSync(dir, {recursive: true, force: true})
    if (error instanceof UpdateError && error.code === 'cancelled') {
      setView({phase: 'ready'})
      return
    }
    const code = error instanceof UpdateError && error.code !== 'cancelled' ? error.code : 'internal'
    console.warn('[update] 更新できませんでした:', code, message(error))
    setView({
      phase: 'error', error: code,
      errorDetail: code === 'location' ? tildify(message(error)) : code === 'disk_space' ? message(error) : '',
    })
  }
}

function beginQuit(plan: QuitPlan): void {
  writePending(updatesDir(), {from: plan.from, to: plan.to, at: Date.now()})
  quitPlan = plan
  job = null
  setView({phase: 'quitting'})
  // 窓の守りや「実行中のセッションがあります」の確認が残っていると、app.quit() が黙って取り消される
  hooks?.allowQuit()
  quitWatch = setTimeout(() => {
    quitWatch = null
    if (!quitPlan) return
    quitPlan = null
    removePending(updatesDir())
    fs.rmSync(path.dirname(plan.backup), {recursive: true, force: true})
    fs.rmSync(path.dirname(plan.next), {recursive: true, force: true})
    if (!win || win.isDestroyed()) openWindow()
    setView({phase: 'error', error: 'quit_failed', errorDetail: ''})
  }, QUIT_WATCH_MS)
  app.quit()
}

/**
 * main.ts の will-quit で、PTY の終了と集計の停止を待った後、最後の終了の直前に呼ぶ。
 * 更新を予約していたときだけ入れ替え、開き直しの sh を起動する。例外は投げない
 */
export async function finishUpdateOnQuit(): Promise<void> {
  const plan = quitPlan
  if (!plan) return
  quitPlan = null
  let open = plan.current
  try {
    const result = swapApp(plan.current, plan.next, plan.backup)
    if (!result.ok) {
      writePending(updatesDir(), {
        from: plan.from, to: plan.to, at: Date.now(), failure: result.restored ? 'swap_failed' : 'stranded',
      })
      if (!result.restored) open = plan.backup
      console.warn('[update] 入れ替えられませんでした:', result.reason)
      if (!testConfig) {
        dialog.showMessageBoxSync({
          type: 'warning',
          message: '更新できませんでした',
          detail: result.restored
            ? `今のバージョンのまま開き直します。（${result.reason}）`
            : `元の場所に戻せなかったため、${tildify(open)} から開き直します。（${result.reason}）`,
          buttons: ['閉じる'],
        })
      }
    }
    const executable = testConfig?.directRelaunch
      ? path.join(open, 'Contents/MacOS', path.basename(process.execPath)) : undefined
    await spawnRelaunch({
      pid: process.pid, app: open, bundleId: identity().bundleId, executable,
      env: executable ? process.env : undefined,
    })
  } catch (error) {
    console.warn('[update] 開き直しを始められませんでした:', message(error))
  }
}

// ---- IPC ----

const fromUpdateWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  win !== null && !win.isDestroyed() && event.sender === win.webContents

export function registerUpdateIpc(): void {
  // 引数は受け取らない(確かめ済みの更新情報は main だけが持つ)
  ipcMain.handle(CH.updateGet, (event) => fromUpdateWindow(event) ? view : null)
  ipcMain.on(CH.updateStart, (event) => {
    if (fromUpdateWindow(event)) void start()
  })
  ipcMain.on(CH.updateCancel, (event) => {
    if (fromUpdateWindow(event) && view && view.phase !== 'quitting') job?.abort()
  })
  ipcMain.on(CH.updateLater, (event) => {
    if (fromUpdateWindow(event) && !busy()) win?.close()
  })
  ipcMain.on(CH.updateOpenReleases, (event) => {
    if (fromUpdateWindow(event)) void shell.openExternal(RELEASES_PAGE)
  })
  app.on('before-quit', () => {
    // ⌘Q: 処理中ならダウンロードをやめ、窓が終了を止めないようにする(更新のための終了はそのまま)
    if (quitPlan) return
    allowClose = true
    job?.abort()
  })
  app.on('will-quit', () => {
    if (quitWatch) clearTimeout(quitWatch)
    quitWatch = null
  })
}

// ---- 撮影用(devshot) ----

/** 偽の更新情報でお知らせの窓を開く。撮影モードでは［今すぐ更新］を押しても何もしない */
export function showUpdateForShot(fake: UpdateRelease, patch: Partial<UpdateView> = {}): BrowserWindow {
  release = fake
  view = {
    phase: 'ready', version: fake.version, current: app.getVersion(), notes: fake.notes,
    sessions: hooks?.liveSessions() ?? 0, received: 0, total: fake.size, error: null, errorDetail: '',
    previousFailure: null, ...patch,
  }
  const shown = openWindow()
  setView({})
  return shown
}

export function setUpdateViewForShot(patch: Partial<UpdateView>): void {
  setView(patch)
}
