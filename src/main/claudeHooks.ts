import {app, dialog, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DESIRED, withClaudeTermHooks} from './hooksSettings'
import {readJsonObject, writeAtomically} from './hookFiles'

const STATUSLINE_SCRIPT = `#!/bin/sh
# claude-term-statusline: claude-term のセッション内でだけ動作するステータスライン。
# stdin の JSON をアプリ(127.0.0.1)へ転送し、整形済みの1行を受け取って表示する。
# claude-term 外のターミナルでは何も出力しない。
# 削除する場合はこのファイルと ~/.claude/settings.json の statusLine 設定を消してください。
if [ -n "$CLAUDE_TERM_PORT" ] && [ -n "$CLAUDE_TERM_SESSION" ]; then
  curl -s -m 1 -X POST --data-binary @- -H 'Content-Type: application/json' \\
    "http://127.0.0.1:$CLAUDE_TERM_PORT/status/$CLAUDE_TERM_SESSION" 2>/dev/null
fi
`

function scriptIsCurrent(scriptPath: string): boolean {
  try {
    return fs.readFileSync(scriptPath, 'utf8') === STATUSLINE_SCRIPT
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function saveConsent(consentPath: string, consent: 'granted' | 'denied'): void {
  const {settings} = readJsonObject(consentPath)
  fs.mkdirSync(path.dirname(consentPath), {recursive: true})
  writeAtomically(consentPath, `${JSON.stringify({...settings, hooksConsent: consent}, null, 2)}\n`)
}

/**
 * ~/.claude/settings.json へガード付き hooks を追記する(初回は同意ダイアログ)。
 * - ガード: $CLAUDE_TERM_PORT が無い通常ターミナルでは no-op
 * - 拒否は userData/config.json に記録し再質問しない
 * - 書換え前の内容は settings.json.backup-claude-term に保存
 */
export async function ensureClaudeHooks(win: BrowserWindow): Promise<void> {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const statuslinePath = path.join(os.homedir(), '.claude', 'claude-term-statusline.sh')
  const consentPath = path.join(app.getPath('userData'), 'config.json')

  try {
    const {settings: config} = readJsonObject(consentPath)
    if (config.hooksConsent === 'denied') return
    const initial = readJsonObject(settingsPath).settings
    const initialMerged = withClaudeTermHooks(initial, statuslinePath)
    if (config.hooksConsent === 'granted' &&
        JSON.stringify(initialMerged) === JSON.stringify(initial) && scriptIsCurrent(statuslinePath)) return

    if (config.hooksConsent !== 'granted') {
      const r = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['追記して有効化', '今はしない'],
        defaultId: 0,
        cancelId: 1,
        message: 'Claude Code の状態検知を有効にしますか?',
        detail:
          `~/.claude/settings.json に、claude-term のセッション内でのみ動作するガード付き hooks(${DESIRED.length}件)と、` +
          'モデル・コンテキスト残量・コストを取得するステータスライン設定(未設定の場合のみ)を追記します。' +
          '通常のターミナルの claude では環境変数ガードにより何もしません。' +
          '書換え前のファイルは settings.json.backup-claude-term に保存します。削除手順は README を参照してください。',
      })
      if (r.response !== 0) {
        saveConsent(consentPath, 'denied')
        return
      }
    }

    // ダイアログを開いている間の編集は、設定本体にもバックアップにも残す。
    readJsonObject(consentPath)
    const {settings, raw} = readJsonObject(settingsPath)
    const merged = withClaudeTermHooks(settings, statuslinePath)
    fs.mkdirSync(path.dirname(settingsPath), {recursive: true})
    if (!scriptIsCurrent(statuslinePath)) writeAtomically(statuslinePath, STATUSLINE_SCRIPT, 0o755)
    if (JSON.stringify(merged) !== JSON.stringify(settings)) {
      if (raw !== null) writeAtomically(`${settingsPath}.backup-claude-term`, raw)
      writeAtomically(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)
    }
    if (config.hooksConsent !== 'granted') saveConsent(consentPath, 'granted')
    console.log('[hooks] ~/.claude/settings.json に状態検知 hooks と statusLine を設定しました')
  } catch (error) {
    const detail = error instanceof Error ? error.message : '設定の保存中にエラーが発生しました。'
    console.warn('[hooks]', detail)
    try {
      if (!win.isDestroyed()) {
        await dialog.showMessageBox(win, {
          type: 'warning', buttons: ['閉じる'],
          message: 'Claude Code の状態検知を設定できませんでした',
          detail: `${detail}\n\n設定を確認した後でアプリを再起動すると、もう一度設定できます。`,
        })
      }
    } catch {
      // ウィンドウが既に閉じられていても、後続の初期化を失敗させない。
    }
  }
}
