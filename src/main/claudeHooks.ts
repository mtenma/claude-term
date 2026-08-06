import {app, dialog, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {DESIRED, withClaudeTermHooks} from './hooksSettings'

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

  let consent: string | undefined
  try {
    consent = (JSON.parse(fs.readFileSync(consentPath, 'utf8')) as {hooksConsent?: string})
      .hooksConsent
  } catch {
    // 未記録
  }
  if (consent === 'denied') return

  let raw = ''
  let settings: Record<string, unknown> = {}
  if (fs.existsSync(settingsPath)) {
    raw = fs.readFileSync(settingsPath, 'utf8')
    try {
      settings = JSON.parse(raw) as Record<string, unknown>
    } catch {
      console.warn('[hooks] ~/.claude/settings.json をパースできないため hooks 連携をスキップします')
      return
    }
  }

  const merged = withClaudeTermHooks(settings, statuslinePath)
  const scriptUpToDate =
    fs.existsSync(statuslinePath) && fs.readFileSync(statuslinePath, 'utf8') === STATUSLINE_SCRIPT
  if (JSON.stringify(merged) === JSON.stringify(settings) && scriptUpToDate) return // 既に最新

  if (consent !== 'granted') {
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
    const granted = r.response === 0
    fs.mkdirSync(path.dirname(consentPath), {recursive: true})
    fs.writeFileSync(
      consentPath,
      JSON.stringify({hooksConsent: granted ? 'granted' : 'denied'}, null, 2),
    )
    if (!granted) return
  }

  fs.mkdirSync(path.dirname(settingsPath), {recursive: true})
  fs.writeFileSync(statuslinePath, STATUSLINE_SCRIPT, {mode: 0o755})
  fs.chmodSync(statuslinePath, 0o755)
  if (raw) fs.writeFileSync(`${settingsPath}.backup-claude-term`, raw)
  fs.writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`)
  console.log('[hooks] ~/.claude/settings.json に状態検知 hooks と statusLine を設定しました')
}
