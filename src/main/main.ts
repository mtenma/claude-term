import {app, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, shell} from 'electron'
import * as path from 'node:path'
import {AGENT_LABELS, CH, type SessionInfo, type SessionsUpdate, type TermAck, type TermInput} from '../shared/types'
import {SessionManager, whenAllPtysExited} from './sessions'
import {getAppearance, setAppearance} from './settings'
import {startHookServer} from './hookServer'
import {ensureClaudeHooks} from './claudeHooks'
import {ensureCodexHooks} from './codexHooks'
import {maybeRunDevshot} from './devshot'
import {restrictWebContents} from './windowSecurity'
import {disposeUsage, openCostWindow, registerUsageIpc, sendAppearanceToCostWindow} from './usageWindow'
import {
  applyUpdateTestPaths, finishUpdateOnQuit, isUpdateTestBuild, notifySessionsChanged, registerUpdateIpc,
  sendAppearanceToUpdateWindow, startAppUpdates,
} from './appUpdate'

// 1ウィンドウ = 1 SessionManager。webContents.id をキーに対応関係を持つ
interface WindowContext {
  win: BrowserWindow
  sm: SessionManager
  closeConfirmed: boolean
}

const contexts = new Map<number, WindowContext>()
let windowSeq = 0
/** will-quit に入った(全部の窓が閉じ、終了が決まった)。この後は窓を作らない */
let quitting = false
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
  // お知らせの窓の「開いているセッション(今 N 件)」も、同じきっかけで数え直す
  notifySessionsChanged()
}

/** 全部の窓の、終了していないセッションの数(更新で終了するもの) */
function liveSessionCount(): number {
  let n = 0
  for (const ctx of contexts.values()) {
    n += ctx.sm.currentUpdate().sessions.filter((s) => s.state !== 'exited').length
  }
  return n
}

/** ターミナルの窓か(コスト画面・お知らせの窓はページ内の操作に回す) */
function isTerminalWindow(win: BrowserWindow): boolean {
  for (const ctx of contexts.values()) {
    if (ctx.win === win) return true
  }
  return false
}

function notifySession(ctx: WindowContext, info: SessionInfo, subtitle: string, body: string): void {
  if (shotMode) return
  // そのセッションを今まさに見ているなら通知しない
  if (ctx.win.isFocused() && ctx.sm.activeId === info.id) return
  if (!Notification.isSupported()) return
  const agent = info.activeAgent ? `${AGENT_LABELS[info.activeAgent]} ` : ''
  const notif = new Notification({title: `${info.title} — ${agent}${subtitle}`, body})
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
  ipcMain.on(CH.termIn, (e, input: TermInput) => smOf(e.sender)?.inputToSession(input))
  ipcMain.on(CH.termResize, (e, size: {cols: number; rows: number}) =>
    smOf(e.sender)?.resize(size.cols, size.rows),
  )
  ipcMain.on(CH.termAck, (e, ack: TermAck) => smOf(e.sender)?.ack(ack))
  ipcMain.on(CH.shellOpenExternal, (_e, url: string) => {
    // ターミナル出力由来の文字列なので http(s) 以外は開かない
    if (typeof url === 'string' && /^https?:\/\//.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(CH.settingsGet, () => getAppearance())
  ipcMain.on(CH.settingsSet, (_e, raw: unknown) => {
    const a = setAppearance(raw)
    // 送信元も含む全ウィンドウへ正規化済みの値を配って同期する
    for (const ctx of contexts.values()) send(ctx, CH.settingsUpdate, a)
    sendAppearanceToCostWindow(a)
    sendAppearanceToUpdateWindow(a)
  })
}

/** コスト画面・お知らせの窓から ⌘, を押したときは、ターミナル窓の外観設定を開く */
async function openSettingsFrom(win: BrowserWindow): Promise<void> {
  let target = isTerminalWindow(win) ? win : [...contexts.values()][0]?.win
  if (!target) {
    if (quitting) return
    target = (await createWindow()).win
  }
  target.focus()
  target.webContents.send(CH.editOpenSettings)
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
    // 外観設定の「背景の透過」を有効にするため常に透過ウィンドウで作る
    // (transparent は生成時のみ指定可能。不透明度は CSS 側で制御する)。
    // transparent はウィンドウをフレームレス化するため、hiddenInset で
    // 信号機ボタンを残し、タイトルバーは renderer 側の帯(ドラッグ領域)で代替する
    transparent: true,
    backgroundColor: '#00000000',
    titleBarStyle: 'hiddenInset',
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
  sm.onClipboardWrite = (text) => clipboard.writeText(text)
  sm.onStateChange = (info) => {
    if (info.state === 'attention') {
      notifySession(
        ctx,
        info,
        '承認待ち',
        info.attentionMessage ?? `${info.activeAgent ? AGENT_LABELS[info.activeAgent] : 'このセッション'} が承認または入力を待っています`,
      )
    }
  }
  sm.onResponseComplete = (info) => {
    if (info.activeAgent) notifySession(ctx, info, '応答完了', `${AGENT_LABELS[info.activeAgent]} の応答が完了しました`)
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
  // viewMenu ロールのうちリロード系は、再読込後にアクティブセッションの
  // 画面が再 attach まで空になるため置かない。DevTools は開発実行時のみ
  const viewItems: Electron.MenuItemConstructorOptions[] = [
    {role: 'resetZoom', label: '実際のサイズ'},
    {role: 'zoomIn', label: '拡大'},
    {role: 'zoomOut', label: '縮小'},
    {type: 'separator'},
    {role: 'togglefullscreen', label: 'フルスクリーンにする'},
  ]
  if (!app.isPackaged) {
    viewItems.push({type: 'separator'}, {role: 'toggleDevTools', label: '開発者ツール'})
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      // appMenu ロールから使わない「サービス」を除いた構成
      label: app.name,
      submenu: [
        {role: 'about', label: 'Claude Term について'},
        {type: 'separator'},
        {
          label: '設定…',
          accelerator: 'CmdOrCtrl+,',
          click: (_item, win) => {
            if (win instanceof BrowserWindow) void openSettingsFrom(win)
          },
        },
        {type: 'separator'},
        {role: 'hide', label: 'Claude Term を隠す'},
        {role: 'hideOthers', label: 'ほかを隠す'},
        {role: 'unhide', label: 'すべてを表示'},
        {type: 'separator'},
        {role: 'quit', label: 'Claude Term を終了'},
      ],
    },
    {
      label: 'ファイル',
      submenu: [
        {
          label: '新規ウィンドウ',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            if (!quitting) void createWindow()
          },
        },
        {type: 'separator'},
        {role: 'close', label: 'ウィンドウを閉じる'},
      ],
    },
    {
      // editMenu ロール一式はターミナルには作用しないものが大半なので、
      // 実際に機能するものだけを置く。コピー/ペーストのロールは
      // ⌘C/⌘V のショートカット配線を兼ねるため削除してはいけない。
      // タイトルのゼロ幅スペースは AppKit の Edit メニュー同定を外し、
      // 作文ツール/音声入力/絵文字と記号(いずれもターミナルでは作用対象が無い)の
      // OS による自動注入を抑止するためのもの
      label: '編集\u200b',
      submenu: [
        {role: 'copy', label: 'コピー'},
        {role: 'paste', label: 'ペースト'},
        {type: 'separator'},
        {
          label: 'すべてを選択',
          accelerator: 'CmdOrCtrl+A',
          click: (_item, win) => {
            if (!(win instanceof BrowserWindow)) return
            // コスト画面・お知らせの窓は通常のページなので、ページ内の文字を選択する
            if (isTerminalWindow(win)) win.webContents.send(CH.editSelectAll)
            else win.webContents.selectAll()
          },
        },
        {type: 'separator'},
        {
          label: '検索',
          accelerator: 'CmdOrCtrl+F',
          click: (_item, win) => {
            if (win instanceof BrowserWindow && isTerminalWindow(win)) win.webContents.send(CH.editFind)
          },
        },
      ],
    },
    {label: '表示', submenu: viewItems},
    {
      // windowMenu ロールを維持すると macOS が開いているウィンドウ一覧を
      // 末尾に自動追加してくれる(複数ウィンドウの切替に使う)
      role: 'windowMenu',
      label: 'ウィンドウ',
      submenu: [
        {role: 'minimize', label: 'しまう'},
        {role: 'zoom', label: '拡大/縮小'},
        {type: 'separator'},
        {label: 'コスト', click: () => openCostWindow()},
        {type: 'separator'},
        {role: 'front', label: 'すべてを手前に移動'},
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  app.dock?.setMenu(
    Menu.buildFromTemplate([{label: '新規ウィンドウ', click: () => {
      if (!quitting) void createWindow()
    }}]),
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
    onCodex: (id, rawJson) => {
      for (const ctx of contexts.values()) ctx.sm.setCodexHook(id, rawJson)
    },
    onCodexExit: (id) => {
      for (const ctx of contexts.values()) ctx.sm.clearCodexSession(id)
    },
    onCodexProcess: (id, runId, event) => {
      for (const ctx of contexts.values()) ctx.sm.setCodexProcess(id, runId, event)
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
  registerUsageIpc()
  registerUpdateIpc()
  setupMenu()

  const first = await createWindow()
  const updateHooks = {
    liveSessions: liveSessionCount,
    allowQuit: () => {
      for (const ctx of contexts.values()) ctx.closeConfirmed = true
    },
    restoreQuitGuard: () => {
      for (const ctx of contexts.values()) ctx.closeConfirmed = false
    },
  }
  if (shotMode) {
    startAppUpdates(updateHooks)
    maybeRunDevshot(first.win, first.sm)
  } else {
    // 検査用の版(アプリの更新の通しの検査)は、同意のダイアログを出さず ~/.claude・~/.codex に触れない
    if (!isUpdateTestBuild()) {
      await ensureClaudeHooks(first.win)
      if (!first.win.isDestroyed()) await ensureCodexHooks(first.win)
    }
    startAppUpdates(updateHooks)
  }
}

applyUpdateTestPaths()
restrictWebContents()

app.on('activate', () => {
  // 終了を待つ間(PTY の終了待ち・アプリの更新の入れ替え)に Dock を押されても窓を作らない。
  // 作ると、その窓の閉じる確認が最後の app.quit() を取り消す
  if (app.isReady() && contexts.size === 0 && !quitting) void createWindow()
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
  quitting = true
  for (const ctx of contexts.values()) ctx.sm.disposeAll()
  void Promise.all([whenAllPtysExited(1500), disposeUsage()]).then(async () => {
    // アプリの更新を予約していれば、ここ(子プロセスも窓も無くなった後)で入れ替えて開き直しを頼む
    await finishUpdateOnQuit()
    // 飛行中の onData 等のコールバックが掃けるまで一拍置く
    setTimeout(() => {
      quitReady = true
      app.quit()
    }, 50)
  })
})

void main()
