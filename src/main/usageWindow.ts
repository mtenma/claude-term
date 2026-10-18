import {app, BrowserWindow, dialog, ipcMain, utilityProcess, type IpcMainEvent, type IpcMainInvokeEvent,
  type UtilityProcess} from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CH, USAGE_PERIODS, type AppearanceSettings, type UsageEvent, type UsagePeriod, type UsageReport}
  from '../shared/types'
import type {ServiceMessage, ServiceRequest, UsageServiceConfig} from './usageProtocol'
import {getAppearance} from './settings'

// コスト画面(1 つだけ開く)と、集計を担う utilityProcess の管理。
// 集計用のプロセスは画面を開いている間だけ動かし、閉じたら終了する

const AUTO_SCAN_INTERVAL_MS = 30_000
const PERIODIC_SCAN_MS = 5 * 60_000
const REPORT_TIMEOUT_MS = 60_000

let win: BrowserWindow | null = null
let service: UtilityProcess | null = null
let serviceExit: Promise<void> | null = null
let requestSeq = 0
const pending = new Map<number, {resolve: (r: UsageReport) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>()
let lastAutoScan = 0
let periodicTimer: NodeJS.Timeout | null = null
// 削除の直後は、利用者が「更新」を押すまで自動では作り直さない
let autoScanSuspended = false

/** 検証時は環境変数で記録の場所・DB・現在時刻を差し替える(実データに書き込まないため) */
function serviceConfig(): UsageServiceConfig {
  const home = os.homedir()
  const absolute = (value: string | undefined) => value && path.isAbsolute(value) ? value : undefined
  const claudeDir = absolute(process.env.CLAUDE_TERM_USAGE_CLAUDE_DIR) ??
    path.join(absolute(process.env.CLAUDE_CONFIG_DIR) ?? path.join(home, '.claude'), 'projects')
  const codexHome = absolute(process.env.CLAUDE_TERM_USAGE_CODEX_DIR) ??
    absolute(process.env.CODEX_HOME) ?? path.join(home, '.codex')
  return {
    db: dbPath(),
    roots: {claude: [claudeDir], codex: [path.join(codexHome, 'sessions'), path.join(codexHome, 'archived_sessions')]},
    home,
  }
}

/** 開発実行はパッケージ版と同じ userData を使うため、DB を分けて同時書込みを避ける */
export function dbPath(): string {
  const override = process.env.CLAUDE_TERM_USAGE_DB
  if (override && path.isAbsolute(override)) return override
  return path.join(app.getPath('userData'), app.isPackaged ? 'usage.sqlite' : 'usage-dev.sqlite')
}

const usageNow = (): number => {
  const fixed = Date.parse(process.env.CLAUDE_TERM_USAGE_NOW ?? '')
  return Number.isFinite(fixed) ? fixed : Date.now()
}

function sendEvent(event: UsageEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.usageEvent, event)
}

function failPending(code: string): void {
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(new Error(code))
    pending.delete(id)
  }
}

function ensureService(): UtilityProcess {
  if (service) return service
  const child = utilityProcess.fork(path.join(__dirname, 'usageService.js'), [], {
    serviceName: 'Claude Term Usage',
    stdio: 'ignore',
  })
  service = child
  serviceExit = new Promise((resolve) => {
    child.once('exit', (code) => {
      if (service === child) {
        service = null
        failPending('service_exited')
        // 画面を閉じたときの終了(kill)以外は、異常終了として画面に知らせる
        if (code !== 0 && win) sendEvent({kind: 'error', code: 'service_exited'})
      }
      resolve()
    })
  })
  child.on('message', (message: ServiceMessage) => {
    if (message.type === 'event') {
      sendEvent(message.event)
    } else {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.type === 'report') entry.resolve(message.report)
      else entry.reject(new Error(message.code))
    }
  })
  const init: ServiceRequest = {type: 'init', config: serviceConfig()}
  child.postMessage(init)
  return child
}

async function stopService(): Promise<void> {
  const current = service
  if (!current) return
  const exited = serviceExit
  service = null
  failPending('service_exited')
  current.kill()
  await exited
}

function requestReport(period: UsagePeriod): Promise<UsageReport> {
  const child = ensureService()
  const id = ++requestSeq
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, REPORT_TIMEOUT_MS)
    pending.set(id, {resolve, reject, timer})
    const message: ServiceRequest = {type: 'report', id, period, now: usageNow()}
    child.postMessage(message)
  })
}

/** manual は「更新」ボタン。自動の取込み(開いた・前面に来た・定期)は 30 秒以内なら省く */
function requestScan(manual: boolean): void {
  if (!manual && (autoScanSuspended || Date.now() - lastAutoScan < AUTO_SCAN_INTERVAL_MS)) return
  if (manual) autoScanSuspended = false
  lastAutoScan = Date.now()
  const message: ServiceRequest = {type: 'scan'}
  ensureService().postMessage(message)
}

const fromCostWindow = (event: IpcMainEvent | IpcMainInvokeEvent): boolean =>
  win !== null && !win.isDestroyed() && event.sender === win.webContents

export function isCostWindow(target: BrowserWindow | null | undefined): boolean {
  return target !== null && target !== undefined && target === win
}

export function sendAppearanceToCostWindow(appearance: AppearanceSettings): void {
  if (win && !win.isDestroyed()) win.webContents.send(CH.settingsUpdate, appearance)
}

export function registerUsageIpc(): void {
  ipcMain.handle(CH.usageReport, async (event, period: unknown) => {
    if (!fromCostWindow(event)) throw new Error('forbidden')
    if (typeof period !== 'string' || !(USAGE_PERIODS as readonly string[]).includes(period)) {
      throw new Error('invalid period')
    }
    const report = await requestReport(period as UsagePeriod)
    requestScan(false)
    return report
  })
  ipcMain.on(CH.usageRefresh, (event) => {
    if (fromCostWindow(event)) requestScan(true)
  })
  ipcMain.handle(CH.usageDelete, async (event) => {
    if (!fromCostWindow(event) || !win) return false
    const file = dbPath()
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['削除', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '集計データを削除しますか?',
      detail: `${file.replace(os.homedir(), '~')} を削除します。Claude Code と Codex の元の記録は消しません。` +
        '「更新」を押すと、残っている記録から作り直します。元の記録が既に消えている期間の集計は戻りません。',
    })
    if (r.response !== 0) return false
    await stopService()
    for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, {force: true})
    autoScanSuspended = true
    sendEvent({kind: 'deleted'})
    return true
  })
}

export function openCostWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore()
    win.focus()
    return win
  }
  const appearance = getAppearance()
  const created = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: 'コスト — Claude Term',
    // グラフが壁紙に透けないよう、透過設定は使わない
    backgroundColor: appearance.background,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/usagePreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win = created
  created.once('ready-to-show', () => created.show())
  created.on('focus', () => requestScan(false))
  periodicTimer = setInterval(() => {
    if (win && win.isVisible() && !win.isMinimized()) requestScan(false)
  }, PERIODIC_SCAN_MS)
  created.on('closed', () => {
    if (win === created) win = null
    if (periodicTimer) clearInterval(periodicTimer)
    periodicTimer = null
    autoScanSuspended = false
    lastAutoScan = 0
    void stopService()
  })
  void created.loadFile(path.join(__dirname, '../renderer/cost.html'))
  return created
}

/** アプリ終了時。取込み中でも SQLite のトランザクション単位で安全に止まる */
export function disposeUsage(): Promise<void> {
  return stopService()
}
