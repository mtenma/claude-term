import {app, dialog, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {CODEX_HOOK_EVENTS, CODEX_RELAY_COMMAND, withCodexTermHooks} from './codexHooksSettings'
import {readJsonObject, writeAtomically} from './hookFiles'

function saveConsent(consentPath: string, consent: 'granted' | 'denied'): void {
  // 同意ダイアログの表示中に保存された Claude 側のキーも保持する。
  const {settings} = readJsonObject(consentPath)
  fs.mkdirSync(path.dirname(consentPath), {recursive: true})
  writeAtomically(consentPath, `${JSON.stringify({...settings, codexHooksConsent: consent}, null, 2)}\n`)
}

/** アプリ起動時に状態通知用 hooks を登録する(初回は同意ダイアログ)。 */
export async function ensureCodexHooks(win: BrowserWindow): Promise<void> {
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex')
  const hooksPath = path.join(codexHome, 'hooks.json')
  const backupPath = `${hooksPath}.backup-claude-term`
  const consentPath = path.join(app.getPath('userData'), 'config.json')
  // 絶対パスを定義へ埋め込むと、開発版と配布版を切り替えるたび Codex の信頼が外れる。
  // 起動元の PTY 環境でパスを渡し、同じ定義を両方から使う。Electron は app.asar も読める。
  const relayCommand = CODEX_RELAY_COMMAND

  try {
    const {settings: config} = readJsonObject(consentPath)
    if (config.codexHooksConsent === 'denied') return
    if (config.codexHooksConsent !== 'granted') {
      // 壊れた既存設定には、同意を記録する前に気付けるようにする。
      withCodexTermHooks(readJsonObject(hooksPath).settings, relayCommand)
      const result = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['追記して有効化', '今はしない'],
        defaultId: 0,
        cancelId: 1,
        message: 'Codex の状態検知を有効にしますか?',
        detail:
          `${hooksPath}\n\n` +
          `このファイルに、claude-term のセッション内でのみ動く状態通知用 hooks (${CODEX_HOOK_EVENTS.length}件) を追記します。` +
          '既存の hooks は保持します。使用量表示のため、そのセッションの記録からトークン数と利用上限の数値も読み取ります。\n\n' +
          `書換え前のファイルは ${backupPath} に保存します。\n\n` +
          '通知を受け取るには、Codex を起動後に /hooks を開き、追加された定義を確認して信頼してください。',
      })
      if (result.response !== 0) {
        saveConsent(consentPath, 'denied')
        return
      }
    }

    // ダイアログ表示中の編集を上書きしないよう、保存前に両方を再読込する。
    readJsonObject(consentPath)
    const {settings, raw} = readJsonObject(hooksPath)
    const merged = withCodexTermHooks(settings, relayCommand)
    if (JSON.stringify(merged) !== JSON.stringify(settings)) {
      fs.mkdirSync(codexHome, {recursive: true})
      if (raw !== null) writeAtomically(backupPath, raw)
      writeAtomically(hooksPath, `${JSON.stringify(merged, null, 2)}\n`)
      console.log(`[codex-hooks] ${hooksPath} に状態通知 hooks を設定しました`)
    }
    // hooks の保存に失敗した場合は未同意のままにして、次回作成時に再試行できるようにする。
    if (config.codexHooksConsent !== 'granted') saveConsent(consentPath, 'granted')
  } catch (error) {
    const detail = error instanceof Error ? error.message : '設定の保存中にエラーが発生しました。'
    console.warn('[codex-hooks]', detail)
    try {
      if (!win.isDestroyed()) {
        await dialog.showMessageBox(win, {
          type: 'warning',
          buttons: ['閉じる'],
          message: 'Codex の状態検知を設定できませんでした',
          detail: `${detail}\n\n設定を確認した後でアプリを再起動すると、もう一度設定できます。`,
        })
      }
    } catch {
      // ウィンドウが閉じられた場合なども、呼び出し元のセッション作成を失敗させない。
    }
  }
}
