import './update.css'
import type {AppearanceSettings, UpdateErrorCode, UpdateFailure, UpdatePhase, UpdateView} from '../shared/types'
import type {ClaudeTermUpdateApi} from '../preload/updatePreload'
import {isLightColor} from './color'

// アップデートのお知らせの窓。状態は main だけが持ち、この画面は届いた状態を映すだけ

declare global {
  interface Window {
    claudeTermUpdate: ClaudeTermUpdateApi
  }
}

const api = window.claudeTermUpdate
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
/** 窓が焦点を得てから、この時間の Enter・Space・Esc は無視する(ターミナルで打っていた続きで押さないように) */
const KEY_GUARD_MS = 700

const BUSY: readonly UpdatePhase[] = ['preparing', 'downloading', 'verifying', 'quitting']
const STEP: Partial<Record<UpdatePhase, string>> = {
  preparing: '準備しています…',
  downloading: 'ダウンロードしています…',
  verifying: '確かめています…',
  quitting: '新しいバージョンに入れ替えます。数秒後に開きます。',
}
const ERROR_TEXT: Record<UpdateErrorCode, (detail: string) => string> = {
  location: (detail) => `この場所（${detail}）のアプリは自動で入れ替えられません。` +
    '「アプリケーション」フォルダに置いて開き直すか、リリースのページから DMG で入れ替えてください。',
  other_instance: () => 'ほかにも Claude Term が起動しています。終了してからもう一度押してください。',
  disk_space: (detail) => `空き容量が足りません（約 ${detail} MB 必要です）。空きを作ってから、もう一度押してください。`,
  network: () => 'ダウンロードできませんでした。インターネットの接続を確かめて、もう一度押してください。',
  corrupt: () => 'ダウンロードしたファイルが壊れていました。もう一度押してください。',
  invalid_app: () => '配布物の中身が正しくありません。リリースのページを確かめてください。',
  quit_failed: () => 'Claude Term を終了できませんでした。開いている確認の画面を閉じてから、もう一度押してください。',
  internal: () => '更新できませんでした。時間をおいてもう一度お試しください。',
}
/** 押し直しても直らない失敗は、リリースのページへ案内する */
const NOT_RETRYABLE: readonly UpdateErrorCode[] = ['location', 'invalid_app']
const PREVIOUS_TEXT: Record<UpdateFailure, string> = {
  swap_failed: '前回の更新では入れ替えられず、今のバージョンのまま開きました。',
  stranded: '前回の更新では入れ替えられませんでした。',
  unknown: '前回の更新は完了しませんでした。',
}

let view: UpdateView | null = null
let lastPhase: UpdatePhase | null = null
let focusedAt = document.hasFocus() ? Date.now() : 0
let firstFocus = true
let swallowSpace = false

function applyAppearance(a: AppearanceSettings): void {
  const root = document.documentElement
  root.style.setProperty('--bg', a.background)
  root.style.setProperty('--text', a.foreground)
  root.style.setProperty('--accent', a.accent)
  root.style.setProperty('--on-accent', isLightColor(a.accent) ? '#000000' : '#ffffff')
  root.dataset.theme = isLightColor(a.background) ? 'light' : 'dark'
}

const mb = (bytes: number): string => {
  const value = bytes / 1_000_000
  return value < 10 ? value.toFixed(1) : String(Math.round(value))
}

function renderCaution(sessions: number): void {
  const box = el('caution')
  box.textContent = '更新すると Claude Term を終了し、新しいバージョンで開き直します。'
  if (sessions === 0) {
    box.append('開いているセッションはありません。')
    return
  }
  box.append(`開いているセッション（今 ${sessions} 件）は、実行中のコマンドや Claude Code・Codex も含めてすべて終了し、` +
    '元に戻りません。Claude Code の会話は ')
  const code = document.createElement('code')
  code.textContent = 'claude --resume'
  box.append(code, ' で続きから始められます。')
}

function render(next: UpdateView): void {
  view = next
  const busy = BUSY.includes(next.phase)
  const wasBusy = lastPhase !== null && BUSY.includes(lastPhase)
  const phaseChanged = next.phase !== lastPhase

  el('version').textContent = `新しいバージョン ${next.version}（今は ${next.current}）`
  el('notes').textContent = next.notes.trim() || '（変更の内容の記載はありません）'
  renderCaution(next.sessions)
  const previous = el('previous')
  previous.hidden = next.previousFailure === null
  previous.textContent = next.previousFailure ? PREVIOUS_TEXT[next.previousFailure] : ''

  el('progress-box').hidden = !busy
  // 読み上げは段の切り替わりだけ(% が変わるたびに読ませない)
  if (phaseChanged) el('step').textContent = STEP[next.phase] ?? ''
  const progress = el<HTMLProgressElement>('progress')
  if (next.phase === 'downloading' && next.total > 0) {
    const ratio = Math.min(1, next.received / next.total)
    progress.value = ratio
    el('amount').textContent = `${Math.floor(ratio * 100)}%（${mb(next.received)} / ${mb(next.total)} MB）`
  } else {
    progress.removeAttribute('value')
    el('amount').textContent = ''
  }

  const error = el('error')
  error.hidden = next.phase !== 'error' || next.error === null
  error.textContent = next.phase === 'error' && next.error ? ERROR_TEXT[next.error](next.errorDetail) : ''

  const later = el<HTMLButtonElement>('later')
  const primary = el<HTMLButtonElement>('primary')
  later.disabled = busy
  if (next.phase === 'ready') {
    primary.textContent = '今すぐ更新'
    primary.disabled = false
  } else if (next.phase === 'error') {
    primary.textContent = next.error && NOT_RETRYABLE.includes(next.error) ? 'リリースのページを開く' : 'もう一度'
    primary.disabled = false
  } else {
    primary.textContent = '中止'
    primary.disabled = next.phase === 'quitting'
  }

  // 押せなくしたボタンから焦点が body へ落ちないように、進み具合の枠へ移す。終わったら［あとで］へ戻す
  if (phaseChanged && busy && !wasBusy) el('progress-box').focus()
  if (phaseChanged && !busy && wasBusy) later.focus()
  lastPhase = next.phase
}

el('later').addEventListener('click', () => api.later())
el('primary').addEventListener('click', () => {
  if (!view) return
  if (view.phase === 'ready') api.start()
  else if (view.phase === 'error') {
    if (view.error && NOT_RETRYABLE.includes(view.error)) api.openReleases()
    else api.start()
  } else if (view.phase !== 'quitting') api.cancel()
})

window.addEventListener('focus', () => {
  focusedAt = Date.now()
  if (firstFocus) {
    firstFocus = false
    const later = el<HTMLButtonElement>('later')
    if (!later.disabled) later.focus()
  }
})

document.addEventListener('keydown', (e) => {
  const guarded = e.key === 'Enter' || e.key === ' ' || e.key === 'Escape'
  if (guarded && (e.repeat || e.isComposing || Date.now() - focusedAt < KEY_GUARD_MS)) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === ' ') swallowSpace = true
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    if (!el<HTMLButtonElement>('later').disabled) api.later()
  }
}, true)

// Space はキーを離したときに押される。無視したキーの続きも押させない
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && swallowSpace) {
    swallowSpace = false
    e.preventDefault()
    e.stopPropagation()
  }
}, true)

api.onSettingsUpdate(applyAppearance)
api.onView(render)
void api.getSettings().then(applyAppearance)
void api.getView().then((v) => {
  if (v) render(v)
  // 焦点を持って開いた(ターミナルに焦点が無かった)ときは、focus が来ないので、ここで［あとで］に置く
  if (firstFocus && document.hasFocus()) {
    firstFocus = false
    const later = el<HTMLButtonElement>('later')
    if (!later.disabled) later.focus()
  }
})
