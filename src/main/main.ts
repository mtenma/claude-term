import {app, BrowserWindow, dialog, ipcMain, Menu, Notification} from 'electron'
import * as path from 'node:path'
import {CH, type SessionInfo, type SessionsUpdate} from '../shared/types'
import {SessionManager, whenAllPtysExited} from './sessions'
import {startHookServer} from './hookServer'
import {ensureClaudeHooks} from './claudeHooks'
import {maybeRunDevshot} from './devshot'

// 1ウィンドウ = 1 SessionManager。webContents.id をキーに対応関係を持つ
interface WindowContext {
  win: BrowserWindow
  sm: SessionManager
  closeConfirmed: boolean
}

const contexts = new Map<number, WindowContext>()
let windowSeq = 0
let hookPort = 0
let shotMode = false

function send(ctx: WindowContext, channel: string, payload: unknown): void {
  if (!ctx.win.isDestroyed()) ctx.win.webContents.send(channel, payload)
}

function smOf(sender: {id: number}): SessionManager | null {
  return contexts.get(sender.id)?.sm ?? null
}

function updateDockBadge(): void {
  let n = 0
  for (const ctx of contexts.values()) {
    n += ctx.sm.currentUpdate().sessions.filter((s) => s.state === 'attention').length
  }
  app.dock?.setBadge(n > 0 ? String(n) : '')
}

function notifyAttention(ctx: WindowContext, info: SessionInfo): void {
  if (shotMode) return
  // そのセッションを今まさに見ているなら通知しない
  if (ctx.win.isFocused() && ctx.sm.activeId === info.id) return
  if (!Notification.isSupported()) return
  const notif = new Notification({
    title: `${info.title} — 承認待ち`,
    body: info.attentionMessage ?? 'Claude Code が承認または入力を待っています',
  })
  notif.on('click', () => {
    if (!ctx.win.isDestroyed()) {
      ctx.win.show()
      ctx.win.focus()
      ctx.sm.attach(info.id)
    }
  })
  notif.show()
}

function registerIpc(): void {
  ipcMain.handle(CH.sessionCreate, (e) => {
    const sm = smOf(e.sender)
    if (!sm) return null
    const info = sm.create()
    sm.attach(info.id)
    return info
  })
  ipcMain.handle(CH.sessionKill, (e, id: string) => {
    smOf(e.sender)?.kill(id)
  })
  ipcMain.handle(
    CH.sessionsRequest,
    (e): SessionsUpdate => smOf(e.sender)?.currentUpdate() ?? {sessions: [], activeId: null},
  )
  ipcMain.on(CH.sessionAttach, (e, id: string) => smOf(e.sender)?.attach(id))
  ipcMain.on(CH.sessionsReorder, (e, ids: string[]) => smOf(e.sender)?.reorder(ids))
  ipcMain.on(CH.termIn, (e, data: string) => smOf(e.sender)?.inputToActive(data))
  ipcMain.on(CH.termResize, (e, size: {cols: number; rows: number}) =>
    smOf(e.sender)?.resize(size.cols, size.rows),
  )
  ipcMain.on(CH.termAck, (e, bytes: number) => smOf(e.sender)?.ack(bytes))
}

function confirmClose(ctx: WindowContext): void {
  void dialog
    .showMessageBox(ctx.win, {
      type: 'warning',
      buttons: ['閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '実行中のセッションがあります',
      detail: 'このウィンドウを閉じると、中のすべてのセッションが終了します。',
    })
    .then((r) => {
      if (r.response === 0) {
        ctx.closeConfirmed = true
        ctx.win.close()
      }
    })
}

async function createWindow(): Promise<WindowContext> {
  const sm = new SessionManager(hookPort, `w${++windowSeq}s`)
  const win = new BrowserWindow({
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
  const ctx: WindowContext = {win, sm, closeConfirmed: false}
  const wcId = win.webContents.id
  contexts.set(wcId, ctx)

  sm.onSessionsUpdate = (u) => {
    send(ctx, CH.sessionsUpdate, u)
    updateDockBadge()
  }
  sm.onTermOut = (p) => send(ctx, CH.termOut, p)
  sm.onStateChange = (info) => {
    if (info.state === 'attention') notifyAttention(ctx, info)
  }

  win.once('ready-to-show', () => win.show())
  win.on('close', (e) => {
    if (!ctx.closeConfirmed && !shotMode && sm.hasLive()) {
      e.preventDefault()
      confirmClose(ctx)
    }
  })
  win.on('closed', () => {
    contexts.delete(wcId)
    sm.disposeAll()
    updateDockBadge()
  })

  await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  return ctx
}

function setupMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {role: 'appMenu'},
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新規ウィンドウ',
          accelerator: 'CmdOrCtrl+N',
          click: () => void createWindow(),
        },
        {type: 'separator'},
        {role: 'close', label: 'ウィンドウを閉じる'},
      ],
    },
    {role: 'editMenu', label: '編集'},
    {role: 'viewMenu', label: '表示'},
    {role: 'windowMenu', label: 'ウィンドウ'},
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.dock?.setMenu(
    Menu.buildFromTemplate([{label: '新規ウィンドウ', click: () => void createWindow()}]),
  )
}

async function main(): Promise<void> {
  await app.whenReady()

  shotMode = Boolean(process.env.CLAUDE_TERM_SCREENSHOT)
  // hook サーバはアプリで1つ。セッション ID がウィンドウ間で一意なので、
  // 全ウィンドウの SessionManager へ配れば持ち主だけが反応する
  hookPort = await startHookServer({
    onState: (id, state, rawBody) => {
      for (const ctx of contexts.values()) ctx.sm.setHookState(id, state, rawBody)
    },
    onStatus: (id, rawJson) => {
      for (const ctx of contexts.values()) {
        const line = ctx.sm.applyStatus(id, rawJson)
        if (line !== null) return line
      }
      return null
    },
  })
  registerIpc()
  setupMenu()

  const first = await createWindow()
  if (shotMode) {
    maybeRunDevshot(first.win, first.sm)
  } else {
    await ensureClaudeHooks(first.win)
  }
}

app.on('activate', () => {
  if (app.isReady() && contexts.size === 0) void createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

// PTY を kill した直後に Node 環境の破棄へ進むと、node-pty が onExit を
// ThreadSafeFunction で配送しようとして abort する(終了時 SIGABRT クラッシュ)。
// quit を一旦止め、全 PTY の onExit が JS 側へ届いてから本当に終了する
let quitReady = false
app.on('will-quit', (e) => {
  if (quitReady) return
  e.preventDefault()
  for (const ctx of contexts.values()) ctx.sm.disposeAll()
  void whenAllPtysExited(1500).then(() => {
    // 飛行中の onData 等のコールバックが掃けるまで一拍置く
    setTimeout(() => {
      quitReady = true
      app.quit()
    }, 50)
  })
})

void main()
