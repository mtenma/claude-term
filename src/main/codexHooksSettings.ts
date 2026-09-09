// Codex hooks.json のマージ処理。ファイルの読み書きは呼び出し元に任せる。
export const CODEX_MARKER = 'claude-term-codex-hook'

// アプリの配置先を定義に埋め込まず、起動元の PTY 環境から受け取る。
export const CODEX_RELAY_COMMAND = '[ "$CLAUDE_TERM_CODEX" = "1" ] && ' +
  '[ -n "$CLAUDE_TERM_PORT" ] && [ -n "$CLAUDE_TERM_SESSION" ] && ' +
  '[ -n "$CLAUDE_TERM_EXECUTABLE" ] && [ -n "$CLAUDE_TERM_CODEX_RELAY" ] && ' +
  'ELECTRON_RUN_AS_NODE=1 "$CLAUDE_TERM_EXECUTABLE" "$CLAUDE_TERM_CODEX_RELAY"'

export const CODEX_HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop',
  'Interrupt',
] as const

interface HookHandler {
  type: string
  command?: string
  [key: string]: unknown
}

interface HookEntry {
  matcher?: string
  hooks: HookHandler[]
  [key: string]: unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function invalidShape(location: string, expected: string): never {
  throw new Error(`Cannot update Codex hooks.json: ${location} must be ${expected}`)
}

function validateHooks(value: unknown): asserts value is Record<string, HookEntry[]> {
  if (!isRecord(value)) invalidShape('hooks', 'an object')
  for (const [event, entries] of Object.entries(value)) {
    const location = `hooks.${event}`
    if (!Array.isArray(entries)) invalidShape(location, 'an array')
    for (const [entryIndex, entry] of entries.entries()) {
      const entryLocation = `${location}[${entryIndex}]`
      if (!isRecord(entry)) invalidShape(entryLocation, 'an object')
      if (entry.matcher !== undefined && typeof entry.matcher !== 'string') {
        invalidShape(`${entryLocation}.matcher`, 'a string')
      }
      if (!Array.isArray(entry.hooks)) invalidShape(`${entryLocation}.hooks`, 'an array')
      for (const [handlerIndex, handler] of entry.hooks.entries()) {
        const handlerLocation = `${entryLocation}.hooks[${handlerIndex}]`
        if (!isRecord(handler)) invalidShape(handlerLocation, 'an object')
        if (typeof handler.type !== 'string' || !handler.type) {
          invalidShape(`${handlerLocation}.type`, 'a non-empty string')
        }
        if (handler.type === 'command' && typeof handler.command !== 'string') {
          invalidShape(`${handlerLocation}.command`, 'a string')
        }
      }
    }
  }
}

/** 既存の設定を保持し、claude-term が管理するコマンドだけを最新版に置き換える。 */
export function withCodexTermHooks(
  settings: Record<string, unknown>,
  relayCommand: string,
): Record<string, unknown> {
  if (!isRecord(settings)) invalidShape('the root value', 'an object')
  if (typeof relayCommand !== 'string' || !relayCommand.trim()) {
    throw new Error('Cannot update Codex hooks.json: relay command must be a non-empty string')
  }
  const out = structuredClone(settings)
  const hooks = out.hooks === undefined ? {} : out.hooks
  validateHooks(hooks)
  out.hooks = hooks

  for (const [event, entries] of Object.entries(hooks)) {
    const retained = entries.flatMap((entry) => {
      const handlers = entry.hooks.filter(
        (handler) => !(handler.type === 'command' && handler.command?.includes(CODEX_MARKER)),
      )
      if (handlers.length === entry.hooks.length) return [entry]
      // 自前コマンドだけの空グループは除去するが、追加のユーザーメタデータは残す。
      if (handlers.length === 0 &&
        Object.keys(entry).every((key) => key === 'hooks' || key === 'matcher')) {
        return []
      }
      return [{...entry, hooks: handlers}]
    })
    if (retained.length === 0 && entries.length > 0) delete hooks[event]
    else hooks[event] = retained
  }

  // stdout と終了コードは Codex の判断に使われるため、通知の失敗も必ず無出力・成功にする。
  // relayCommand は環境変数ガードを含むシェルコマンドを呼び出し元から受け取る。
  const command = `( ${relayCommand}\n) >/dev/null 2>&1 || true # ${CODEX_MARKER}`
  for (const event of CODEX_HOOK_EVENTS) {
    const entry: HookEntry = {hooks: [{type: 'command', command, timeout: 2}]}
    // compact はターン実行中にも発火するため、起動時の待機状態には戻さない。
    if (event === 'SessionStart') entry.matcher = 'startup|resume|clear'
    const entries = (hooks[event] ??= [])
    entries.push(entry)
  }
  return out
}
