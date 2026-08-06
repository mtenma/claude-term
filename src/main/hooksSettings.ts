// ~/.claude/settings.json へのガード付き hooks マージ(純粋ロジック)。
// electron 非依存にして scripts/smoke-hooks.mjs から機械検証できるようにしている。

// このマーカーを含むコマンドを claude-term 管理の hook とみなす(冪等追記・更新・削除の目印)
export const MARKER = 'claude-term-state-hook'
// statusLine スクリプトのパスに含まれるマーカー(自前設定の判別用)
export const SL_MARKER = 'claude-term-statusline'

interface HookCommand {
  type: string
  command?: string
  [k: string]: unknown
}

interface HookEntry {
  matcher?: string
  hooks?: HookCommand[]
  [k: string]: unknown
}

export const hookCommand = (state: string, withBody = false): string =>
  `[ -n "$CLAUDE_TERM_PORT" ] && curl -s -m 1 -X POST ${
    withBody ? `--data-binary @- -H 'Content-Type: application/json' ` : ''
  }"http://127.0.0.1:$CLAUDE_TERM_PORT/state/$CLAUDE_TERM_SESSION/${state}" >/dev/null 2>&1 || true # ${MARKER}`

// idle_prompt(応答完了後の放置)は意図的に登録しない。
// 放置は「待機(グレー)」のままにし、オレンジは「ユーザーの操作で止まっている」だけに絞る。
export const DESIRED: Array<{event: string; matcher?: string; state: string; withBody?: boolean}> =
  [
    {event: 'UserPromptSubmit', state: 'running'},
    {event: 'PreToolUse', state: 'running'},
    {event: 'PostToolUse', state: 'running'},
    {
      event: 'Notification',
      matcher: 'permission_prompt|elicitation_dialog|agent_needs_input',
      state: 'attention',
      withBody: true, // 通知の message(何の承認を求めているか)を転送する
    },
    {event: 'Stop', state: 'idle'},
    {event: 'SessionEnd', state: 'clear'},
  ]

/**
 * 既存 settings から claude-term の hook を全て取り除いた上で最新版を追記する(冪等)。
 * statuslineCommand を渡すと statusLine 設定も追加する。ただしユーザー自身の
 * statusLine が既に設定されている場合は一切触れない(claude-term 由来のものだけ更新)。
 */
export function withClaudeTermHooks(
  settings: Record<string, unknown>,
  statuslineCommand?: string,
): Record<string, unknown> {
  const out = structuredClone(settings)
  const hooks = (typeof out.hooks === 'object' && out.hooks !== null ? out.hooks : {}) as Record<
    string,
    HookEntry[]
  >
  out.hooks = hooks
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event]
    if (!Array.isArray(arr)) continue
    for (const entry of arr) {
      if (Array.isArray(entry?.hooks)) {
        entry.hooks = entry.hooks.filter(
          (h) => !(typeof h?.command === 'string' && h.command.includes(MARKER)),
        )
      }
    }
    hooks[event] = arr.filter((entry) => !Array.isArray(entry?.hooks) || entry.hooks.length > 0)
    if (hooks[event].length === 0) delete hooks[event]
  }
  for (const d of DESIRED) {
    const arr = (hooks[d.event] ??= [])
    const entry: HookEntry = {
      hooks: [{type: 'command', command: hookCommand(d.state, d.withBody)}],
    }
    if (d.matcher) entry.matcher = d.matcher
    arr.push(entry)
  }
  if (statuslineCommand) {
    const existing = out.statusLine as {type?: string; command?: string} | undefined
    const isOurs = typeof existing?.command === 'string' && existing.command.includes(SL_MARKER)
    if (!existing || isOurs) {
      out.statusLine = {type: 'command', command: statuslineCommand}
    }
  }
  return out
}
