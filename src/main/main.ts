import {app, BrowserWindow, dialog, ipcMain, Notification} from 'electron'
import * as path from 'node:path'
import {CH, type SessionInfo, type SessionsUpdate} from '../shared/types'
import {SessionManager} from './sessions'
import {startHookServer} from './hookServer'
import {ensureClaudeHooks} from './claudeHooks'
import {maybeRunDevshot} from './devshot'

let win: BrowserWindow | null = null
let sm: SessionManager | null = null
let quitConfirmed = false
let shotMode = false

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function updateDockBadge(update: SessionsUpdate): void {
  const n = update.sessions.filter((s) => s.state === 'attention').length
  app.dock?.setBadge(n > 0 ? String(n) : '')
}

function notifyAttention(info: SessionInfo): void {
  if (shotMode) return
  // そのセッションを今まさに見ているなら通知しない
  if (win?.isFocused() && sm?.activeId === info.id) return
  if (!Notification.isSupported()) return
  const notif = new Notification({
    title: `${info.title} — 承認待ち`,
    body: info.attentionMessage ?? 'Claude Code が承認または入力を待っています',
  })
  notif.on('click', () => {
    if (win) {
      win.show()
      win.focus()
    }
    sm?.attach(info.id)
  })
  notif.show()
}

function registerIpc(manager: SessionManager): void {
  ipcMain.handle(CH.sessionCreate, () => {
    const info = manager.create()
    manager.attach(info.id)
    return info
  })
  ipcMain.handle(CH.sessionKill, (_e, id: string) => {
    manager.kill(id)
  })
  ipcMain.handle(CH.sessionsRequest, () => manager.currentUpdate())
  ipcMain.on(CH.sessionAttach, (_e, id: string) => manager.attach(id))
  ipcMain.on(CH.termIn, (_e, data: string) => manager.inputToActive(data))
  ipcMain.on(CH.termResize, (_e, size: {cols: number; rows: number}) =>
    manager.resize(size.cols, size.rows),
  )
  ipcMain.on(CH.termAck, (_e, bytes: number) => manager.ack(bytes))
}

function confirmClose(window: BrowserWindow): void {
  void dialog
    .showMessageBox(window, {
      type: 'warning',
      buttons: ['終了', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '実行中のセッションがあります',
      detail: '終了するとすべてのセッションが閉じられます。',
    })
    .then((r) => {
      if (r.response === 0) {
        quitConfirmed = true
        window.close()
      }
    })
}

async function main(): Promise<void> {
  await app.whenReady()

  shotMode = Boolean(process.env.CLAUDE_TERM_SCREENSHOT)
  const port = await startHookServer({
    onState: (id, state, rawBody) => sm?.setHookState(id, state, rawBody),
    onStatus: (id, rawJson) => sm?.applyStatus(id, rawJson) ?? null,
  })
  sm = new SessionManager(port)

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Claude Term',
    backgroundColor: '#0f0f11',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !shotMode,
    },
  })

  sm.onSessionsUpdate = (u) => {
    send(CH.sessionsUpdate, u)
    updateDockBadge(u)
  }
  sm.onTermOut = (p) => send(CH.termOut, p)
  sm.onStateChange = (info) => {
    if (info.state === 'attention') notifyAttention(info)
  }
  registerIpc(sm)

  win.once('ready-to-show', () => win?.show())
  win.on('close', (e) => {
    if (!quitConfirmed && !shotMode && sm?.hasLive() && win) {
      e.preventDefault()
      confirmClose(win)
    }
  })
  win.on('closed', () => {
    win = null
  })

  await win.loadFile(path.join(__dirname, '../renderer/index.html'))

  if (shotMode) {
    maybeRunDevshot(win, sm)
  } else {
    await ensureClaudeHooks(win)
  }
}

app.on('window-all-closed', () => {
  sm?.disposeAll()
  app.quit()
})

app.on('will-quit', () => {
  sm?.disposeAll()
})

void main()
