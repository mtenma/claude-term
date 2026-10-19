import type {BrowserWindow} from 'electron'
import {CH, DEFAULT_APPEARANCE} from '../shared/types'
import {setUpdateViewForShot, showUpdateForShot} from './appUpdate'
import type {SessionManager} from './sessions'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const XSS_NOTE = '<img src=x onerror="document.title=1">'
const FAKE = {
  version: '0.1.99',
  notes: `- コスト画面を追加しました\n- 新しい版のお知らせと更新\n- ${XSS_NOTE}`,
  url: 'https://example.invalid/fake.zip',
  sha256: '0'.repeat(64),
  size: 123_000_000,
}

type Variant = 'update' | 'update-light' | 'update-busy' | 'update-error' | 'update-zoom'

async function waitFor(win: BrowserWindow, expression: string, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!win.isDestroyed() && await win.webContents.executeJavaScript(expression)) return
    await delay(100)
  }
  throw new Error(`update window: ${label} did not happen`)
}

const js = <T>(win: BrowserWindow, expression: string): Promise<T> =>
  win.webContents.executeJavaScript(expression) as Promise<T>

const key = (win: BrowserWindow, keyCode: string) => {
  win.webContents.sendInputEvent({type: 'keyDown', keyCode})
  win.webContents.sendInputEvent({type: 'keyUp', keyCode})
}

/** 下の帯(ボタン)が窓の中に見えていて、横にはみ出していないこと */
async function layoutProblems(win: BrowserWindow): Promise<string[]> {
  const box = await js<{footBottom: number; height: number; overflow: number}>(win, `({
    footBottom: document.querySelector('.foot').getBoundingClientRect().bottom,
    height: window.innerHeight,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  })`)
  const problems: string[] = []
  if (box.footBottom > box.height + 1) problems.push(`buttons are cut off (${box.footBottom} > ${box.height})`)
  if (box.overflow > 0) problems.push(`horizontal overflow ${box.overflow}`)
  return problems
}

/** 主ボタンの文字と背景のコントラスト比(WCAG)。13px の太字なので 4.5:1 を求める */
const primaryContrast = (win: BrowserWindow) => js<number>(win, `(() => {
  const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number)
  const lum = ([r, g, b]) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const style = getComputedStyle(document.getElementById('primary'))
  const a = lum(rgb(style.color))
  const b = lum(rgb(style.backgroundColor))
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
})()`)

async function open(onOpen: (win: BrowserWindow) => void, patch = {}, notes = FAKE.notes): Promise<BrowserWindow> {
  const win = showUpdateForShot({...FAKE, notes}, patch)
  onOpen(win)
  await waitFor(win, `document.getElementById('version').textContent.includes('0.1.99')`, 'render')
  return win
}

/**
 * お知らせの窓を偽の更新情報で開き、表示と操作を検証する。撮影モードでは［今すぐ更新］を押しても何もしない
 * (ダウンロードや入れ替えは動かない)
 */
export async function checkUpdateWindow(variant: Variant, sm: SessionManager,
  onOpen: (win: BrowserWindow) => void): Promise<void> {
  const problems: string[] = []
  let win = await open(onOpen)

  if (variant === 'update') {
    // 既定の外観(強調色 #d97757)でも、主ボタンの文字が読める
    win.webContents.send(CH.settingsUpdate, DEFAULT_APPEARANCE)
    await delay(200)
    const contrast = await primaryContrast(win)
    if (contrast < 4.5) problems.push(`primary contrast with the default accent is ${contrast.toFixed(2)}`)
    // 変更の内容の HTML は文字のまま表示され、要素として解釈されない
    const dom = await js<{images: number; notes: string; title: string; role: string | null}>(win, `({
      images: document.querySelectorAll('img').length,
      notes: document.getElementById('notes').textContent,
      title: document.title,
      role: document.querySelector('.dialog').getAttribute('role'),
    })`)
    if (dom.images !== 0 || !dom.notes.includes(XSS_NOTE) || dom.title === '1') problems.push('notes were interpreted as HTML')
    if (dom.role !== 'alertdialog') problems.push(`role=${dom.role}`)
    problems.push(...await layoutProblems(win))

    // セッションの数え直し: 作ると増え、終了させると「ありません」に戻る
    const a = sm.create()
    await waitFor(win, `document.getElementById('caution').textContent.includes('今 1 件')`, 'session count 1')
    sm.kill(a.id)
    await waitFor(win, `document.getElementById('caution').textContent.includes('ありません')`, 'session count 0')

    // 焦点を得た直後の Enter は無視する(ターミナルで打っていた続きで［あとで］を押さない)
    win.focus()
    await waitFor(win, `document.activeElement && document.activeElement.id === 'later'`, 'initial focus on later')
    key(win, 'Return')
    await delay(300)
    if (win.isDestroyed() || !win.isVisible()) problems.push('Enter right after focus closed the window')
    else {
      await delay(800)
      key(win, 'Escape')
      await delay(500)
      if (!win.isDestroyed()) problems.push('Escape did not close the window')
      // 撮影のために開き直す
      win = await open(onOpen)
    }
  } else if (variant === 'update-light') {
    win.webContents.send(CH.settingsUpdate, {...DEFAULT_APPEARANCE, background: '#fafaf9', foreground: '#1c1917', accent: '#facc15'})
    await waitFor(win, `document.documentElement.dataset.theme === 'light'`, 'light theme')
    // 明るい強調色(黄)の主ボタンの文字は黒にする
    const color = await js<string>(win, `getComputedStyle(document.getElementById('primary')).color`)
    if (color !== 'rgb(0, 0, 0)') problems.push(`primary text on yellow is ${color}`)
    const contrast = await primaryContrast(win)
    if (contrast < 4.5) problems.push(`primary contrast on yellow is ${contrast.toFixed(2)}`)
    problems.push(...await layoutProblems(win))
  } else if (variant === 'update-busy') {
    setUpdateViewForShot({phase: 'downloading', received: 45_000_000, total: 123_000_000})
    await waitFor(win, `!document.getElementById('progress-box').hidden`, 'progress')
    const dom = await js<{amount: string; later: boolean; primary: string; focus: string}>(win, `({
      amount: document.getElementById('amount').textContent,
      later: document.getElementById('later').disabled,
      primary: document.getElementById('primary').textContent,
      focus: document.activeElement && document.activeElement.id,
    })`)
    if (dom.amount !== '36%（45 / 123 MB）') problems.push(`amount=${dom.amount}`)
    if (!dom.later) problems.push('later is enabled while downloading')
    if (dom.primary !== '中止') problems.push(`primary=${dom.primary}`)
    // 押せなくしたボタンから焦点が body へ落ちず、進み具合の枠にある
    if (dom.focus !== 'progress-box') problems.push(`focus=${dom.focus}`)
    // 処理中は閉じない(閉じるボタン・Esc・close())
    if (win.isClosable()) problems.push('window is closable while downloading')
    win.focus()
    await delay(800)
    key(win, 'Escape')
    win.close()
    await delay(400)
    if (win.isDestroyed()) {
      problems.push('window closed while downloading')
      win = await open(onOpen, {phase: 'downloading', received: 45_000_000, total: 123_000_000})
    }
  } else if (variant === 'update-error') {
    // 処理中から失敗に変わったら、焦点を［あとで］へ戻し、直らない失敗はリリースのページへ案内する
    setUpdateViewForShot({phase: 'preparing'})
    await waitFor(win, `document.activeElement && document.activeElement.id === 'progress-box'`, 'busy focus')
    setUpdateViewForShot({phase: 'error', error: 'location', errorDetail: '~/Downloads/Claude Term.app'})
    await waitFor(win, `!document.getElementById('error').hidden`, 'error')
    const dom = await js<{text: string; role: string | null; primary: string; focus: string; closable: boolean}>(win, `({
      text: document.getElementById('error').textContent,
      role: document.getElementById('error').getAttribute('role'),
      primary: document.getElementById('primary').textContent,
      focus: document.activeElement && document.activeElement.id,
      closable: true,
    })`)
    if (!dom.text.includes('~/Downloads/Claude Term.app')) problems.push(`error=${dom.text}`)
    if (dom.role !== 'alert') problems.push(`error role=${dom.role}`)
    if (dom.primary !== 'リリースのページを開く') problems.push(`primary=${dom.primary}`)
    if (dom.focus !== 'later') problems.push(`focus after error=${dom.focus}`)
    if (!win.isClosable()) problems.push('window is not closable after error')
    setUpdateViewForShot({error: 'network', errorDetail: ''})
    await waitFor(win, `document.getElementById('primary').textContent === 'もう一度'`, 'retry button')
  } else if (variant === 'update-zoom') {
    // 拡大(⌘+)と長い変更の内容でも、下の帯のボタンが窓の中に見える
    win.close()
    await delay(300)
    const long = Array.from({length: 60}, (_, i) => `- ${i + 1} 行目の変更点。長い説明が続きます。`).join('\n')
    win = await open(onOpen, {}, long)
    // 拡大は file:// の画面すべてで共有され、プロファイルに保存されるので、確かめたら必ず戻す
    win.webContents.setZoomLevel(2)
    try {
      await delay(500)
      problems.push(...await layoutProblems(win))
      const scrollable = await js<boolean>(win,
        `(() => { const n = document.getElementById('notes'); return n.scrollHeight > n.clientHeight })()`)
      if (!scrollable) problems.push('long notes are not scrollable')
    } finally {
      win.webContents.setZoomLevel(0)
    }
    await delay(300)
  }

  if (problems.length) throw new Error(`update window: ${problems.join(', ')}`)
}
