// Claude / Codex hooks 設定のマージロジックの機械検証。
// ユーザーの設定ファイルを書き換えるコードなので、冪等性と既存設定の保全を必ず確認する。
import * as esbuild from 'esbuild'
import {spawnSync} from 'node:child_process'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

await esbuild.build({
  entryPoints: ['src/main/hooksSettings.ts', 'src/main/codexHooksSettings.ts'],
  outdir: 'dist-test',
  outExtension: {'.js': '.cjs'},
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'silent',
})

const {withClaudeTermHooks, MARKER, SL_MARKER, DESIRED} = require(
  path.join(root, 'dist-test/hooksSettings.cjs'),
)
const {withCodexTermHooks, CODEX_MARKER, CODEX_HOOK_EVENTS} = require(
  path.join(root, 'dist-test/codexHooksSettings.cjs'),
)

const SL_PATH = `/Users/test/.claude/${SL_MARKER}.sh`

let pass = true
const check = (cond, label) => {
  if (cond) console.log(`ok   ${label}`)
  else {
    pass = false
    console.error(`FAIL ${label}`)
  }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// 1) 空設定 → 全イベントにガード付きコマンドが入る
const fromEmpty = withClaudeTermHooks({}, SL_PATH)
check(
  DESIRED.every((d) => Array.isArray(fromEmpty.hooks[d.event])),
  '空設定から全イベントが追加される',
)
const allCommands = Object.values(fromEmpty.hooks)
  .flat()
  .flatMap((e) => e.hooks ?? [])
  .map((h) => h.command)
check(
  allCommands.length === DESIRED.length &&
    allCommands.every((c) => c.includes('[ -n "$CLAUDE_TERM_PORT" ]') && c.includes(MARKER)),
  '全コマンドに環境変数ガードとマーカーが付く',
)

check(
  eq(fromEmpty.statusLine, {type: 'command', command: SL_PATH}),
  'statusLine が未設定なら claude-term のスクリプトを設定する',
)
const notifMatcher = fromEmpty.hooks.Notification?.[0]?.matcher ?? ''
check(
  notifMatcher.includes('permission_prompt') &&
    notifMatcher.includes('elicitation_dialog') &&
    notifMatcher.includes('agent_needs_input') &&
    !notifMatcher.includes('idle_prompt'),
  '承認待ちの Notification は idle_prompt を含まない',
)
const idleNotification = fromEmpty.hooks.Notification?.find((entry) => entry.matcher === 'idle_prompt')
check(
  idleNotification?.hooks?.[0]?.command.includes('/idle') &&
    idleNotification.hooks[0].command.includes('--data-binary @-'),
  'idle_prompt は完了通知と区別できるイベント情報付きで待機に戻す',
)

// 2) 冪等: 2回適用しても変化しない
check(
  eq(withClaudeTermHooks(fromEmpty, SL_PATH), fromEmpty),
  '2回適用しても結果が変わらない(冪等)',
)

// 3) 既存のユーザー hook を保全し、他のトップレベル設定にも触れない
const userSettings = {
  model: 'opus',
  permissions: {allow: ['Bash(ls:*)']},
  statusLine: {type: 'command', command: 'my-own-statusline.sh'},
  hooks: {
    PreToolUse: [{matcher: 'Bash', hooks: [{type: 'command', command: 'echo my-own-hook'}]}],
    // claude-term が管理しないイベント(無関係イベントの不変性チェック用)
    PreCompact: [{hooks: [{type: 'command', command: 'echo hello'}]}],
  },
}
const merged = withClaudeTermHooks(userSettings, SL_PATH)
check(
  merged.model === 'opus' && eq(merged.permissions, userSettings.permissions),
  'hooks 以外のトップレベル設定に触れない',
)
check(
  eq(merged.hooks.PreToolUse[0], userSettings.hooks.PreToolUse[0]) &&
    merged.hooks.PreToolUse.length === 2,
  '既存のユーザー hook を保全しつつ追記する',
)
check(eq(merged.hooks.PreCompact, userSettings.hooks.PreCompact), '無関係なイベントは不変')
check(
  eq(merged.statusLine, userSettings.statusLine),
  'ユーザー自身の statusLine 設定には触れない',
)
const staleSl = withClaudeTermHooks(
  {statusLine: {type: 'command', command: `/old/path/${SL_MARKER}.sh`}},
  SL_PATH,
)
check(
  eq(staleSl.statusLine, {type: 'command', command: SL_PATH}),
  'claude-term 由来の古い statusLine は最新パスに更新される',
)
check(!eq(userSettings.hooks.PreToolUse, merged.hooks.PreToolUse) === true &&
  userSettings.hooks.PreToolUse.length === 1, '入力オブジェクトを破壊しない')

// 4) 旧バージョンのマーカー付きコマンドは置き換わり、重複しない
const stale = structuredClone(merged)
stale.hooks.Stop[stale.hooks.Stop.length - 1].hooks[0].command = `old-command # ${MARKER}`
const upgraded = withClaudeTermHooks(stale, SL_PATH)
const stopCommands = upgraded.hooks.Stop.flatMap((e) => e.hooks ?? []).map((h) => h.command)
check(
  stopCommands.filter((c) => c.includes(MARKER)).length === 1 &&
    !stopCommands.some((c) => c.startsWith('old-command')),
  '旧マーカーコマンドが最新版に置き換わる(重複なし)',
)

for (const invalid of [null, [], 'invalid', {hooks: null}, {hooks: []},
  {hooks: {Stop: {}}}, {hooks: {Stop: [null]}}, {hooks: {Stop: [{hooks: [null]}]}},
  {hooks: {Stop: [{hooks: [{type: 'command'}]}]}}]) {
  const original = JSON.stringify(invalid)
  let rejected = false
  try { withClaudeTermHooks(invalid, SL_PATH) } catch { rejected = true }
  check(rejected && JSON.stringify(invalid) === original,
    `Claude の不正な構造は入力を保持して拒否する (${original})`)
}

// 5) Codex の全ライフサイクルに無出力・短いタイムアウトの通知を追加する
const codexRelay = '[ -n "$CLAUDE_TERM_PORT" ] && /bin/cat'
const codexEmpty = withCodexTermHooks({}, codexRelay)
const expectedCodexEvents = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse',
  'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt',
]
check(
  eq(CODEX_HOOK_EVENTS, expectedCodexEvents) &&
    eq(Object.keys(codexEmpty.hooks), expectedCodexEvents) &&
    expectedCodexEvents.every((event) => codexEmpty.hooks[event].length === 1),
  'Codex の起動・終了・実行・承認待ち・完了・中断イベントを各1件登録する',
)
const codexHandlers = Object.values(codexEmpty.hooks).flat().flatMap((entry) => entry.hooks)
check(
  codexHandlers.every((handler) =>
    handler.type === 'command' && handler.command.includes(codexRelay) &&
    handler.command.includes(`# ${CODEX_MARKER}`) &&
    handler.timeout > 0 && handler.timeout <= 2,
  ),
  'Codex のコマンドは環境変数ガードを保持し、マーカーと2秒以下の制限を持つ',
)
const startMatcher = new RegExp(codexEmpty.hooks.SessionStart[0].matcher)
check(
  ['startup', 'resume', 'clear'].every((source) => startMatcher.test(source)) &&
    !startMatcher.test('compact'),
  'Codex の SessionStart は compact によって実行状態を待機に戻さない',
)
check(
  eq(withCodexTermHooks(codexEmpty, codexRelay), codexEmpty),
  'Codex の空設定に繰り返し適用しても結果が変わらない',
)
const hookEnvironment = {...process.env}
delete hookEnvironment.CLAUDE_TERM_PORT
const disabledCodexHook = spawnSync('/bin/sh', ['-c', codexHandlers[0].command], {
  env: hookEnvironment, input: '{"decision":"block"}', encoding: 'utf8',
})
const enabledCodexHook = spawnSync('/bin/sh', ['-c', codexHandlers[0].command], {
  env: {...hookEnvironment, CLAUDE_TERM_PORT: '1'},
  input: '{"decision":"block"}', encoding: 'utf8',
})
const failingCodexCommand = withCodexTermHooks(
  {}, 'printf \'{"decision":"block"}\'; printf error >&2; exit 2',
).hooks.PermissionRequest[0].hooks[0].command
const failingCodexHook = spawnSync('/bin/sh', ['-c', failingCodexCommand], {encoding: 'utf8'})
check(
  [disabledCodexHook, enabledCodexHook, failingCodexHook].every((result) =>
    !result.error && result.status === 0 && result.stdout === '' && result.stderr === '',
  ),
  'Codex 通知は無効時・成功時・失敗時とも無出力で成功し、承認判断を返さない',
)

// 6) ユーザーの hook と全階層のメタデータを保持する
const codexUserSettings = {
  description: 'My Codex hooks',
  metadata: {owner: 'user', flags: ['keep']},
  hooks: {
    PreToolUse: [{
      matcher: '^Bash$',
      description: 'Keep this group',
      metadata: {nested: ['keep']},
      hooks: [
        {type: 'command', command: 'echo user-hook', timeout: 30, statusMessage: 'Checking'},
        {type: 'command', command: `old-pre-tool # ${CODEX_MARKER}`, timeout: 10},
        {type: 'mcp_tool', server: 'scanner', tool: 'check', input: {value: CODEX_MARKER}},
        // コマンド以外の handler に同じ文字列があっても管理対象にしない。
        {type: 'prompt', prompt: 'Keep this', command: CODEX_MARKER, metadata: {keep: true}},
      ],
    }],
    SessionEnd: [{
      matcher: 'other',
      description: 'Keep metadata after removing the managed command',
      metadata: {nested: ['keep']},
      hooks: [{type: 'command', command: `old-end # ${CODEX_MARKER}`}],
    }],
    PreCompact: [{hooks: [{type: 'command', command: 'echo compact', async: true}]}],
    PostCompact: [{matcher: 'auto', hooks: []}],
    SubagentStop: [],
  },
}
const codexBefore = structuredClone(codexUserSettings)
const codexMerged = withCodexTermHooks(codexUserSettings, codexRelay)
const expectedPreToolEntry = structuredClone(codexUserSettings.hooks.PreToolUse[0])
expectedPreToolEntry.hooks.splice(1, 1)
check(
  codexMerged.description === codexUserSettings.description &&
    eq(codexMerged.metadata, codexUserSettings.metadata),
  'Codex のトップレベル説明・メタデータを保持する',
)
check(
  eq(codexMerged.hooks.PreToolUse[0], expectedPreToolEntry) &&
    codexMerged.hooks.PreToolUse.length === 2 &&
    eq(codexMerged.hooks.SessionEnd[0], {...codexUserSettings.hooks.SessionEnd[0], hooks: []}),
  'Codex の自前コマンドだけを除去し、他の handler とグループのメタデータを保持する',
)
check(
  ['PreCompact', 'PostCompact', 'SubagentStop'].every((event) =>
    eq(codexMerged.hooks[event], codexUserSettings.hooks[event]),
  ),
  'Codex の無関係なイベントと既存の空エントリは不変',
)
check(eq(codexUserSettings, codexBefore), 'Codex の入力設定を破壊しない')
check(
  eq(withCodexTermHooks(codexMerged, codexRelay), codexMerged),
  'Codex のユーザー設定を含むマージも冪等',
)

// 7) 旧イベント・重複を含めて自前コマンドだけ更新する
const codexStale = structuredClone(codexMerged)
codexStale.hooks.Stop.push({hooks: [
  {type: 'command', command: `old-stop # ${CODEX_MARKER}`},
  {type: 'command', command: `duplicate-stop # ${CODEX_MARKER}`},
]})
codexStale.hooks.LegacyEvent = [{matcher: '*', hooks: [
  {type: 'command', command: `obsolete # ${CODEX_MARKER}`},
]}]
const upgradedRelay = '[ -n "$CLAUDE_TERM_PORT" ] && /bin/cat -u'
const codexUpgraded = withCodexTermHooks(codexStale, upgradedRelay)
const managedCodexHandlers = Object.values(codexUpgraded.hooks).flat().flatMap((entry) =>
  entry.hooks.filter((handler) => handler.type === 'command' && handler.command.includes(CODEX_MARKER)),
)
check(
  managedCodexHandlers.length === expectedCodexEvents.length &&
    managedCodexHandlers.every((handler) => handler.command.includes(upgradedRelay)) &&
    !('LegacyEvent' in codexUpgraded.hooks) &&
    expectedCodexEvents.every((event) =>
      codexUpgraded.hooks[event].flatMap((entry) => entry.hooks).filter((handler) =>
        handler.type === 'command' && handler.command.includes(CODEX_MARKER),
      ).length === 1,
    ),
  'Codex の旧・重複・廃止イベントの自前コマンドを除去し、最新版を各1件にする',
)

// 8) 不正な構造は上書きせず、設定箇所を含むエラーで中止する
const malformedCodexSettings = [
  [null, 'root'],
  [[], 'root'],
  [{hooks: null}, 'hooks'],
  [{hooks: []}, 'hooks'],
  [{hooks: 'invalid'}, 'hooks'],
  [{hooks: {Stop: {hooks: []}}}, 'hooks.Stop'],
  [{hooks: {Stop: [null]}}, 'hooks.Stop[0]'],
  [{hooks: {Stop: [[]]}}, 'hooks.Stop[0]'],
  [{hooks: {Stop: [{}]}}, 'hooks.Stop[0].hooks'],
  [{hooks: {Stop: [{hooks: 'invalid'}]}}, 'hooks.Stop[0].hooks'],
  [{hooks: {Stop: [{matcher: [], hooks: []}]}}, 'hooks.Stop[0].matcher'],
  [{hooks: {Stop: [{hooks: [null]}]}}, 'hooks.Stop[0].hooks[0]'],
  [{hooks: {Stop: [{hooks: [{}]}]}}, 'hooks.Stop[0].hooks[0].type'],
  [{hooks: {Stop: [{hooks: [{type: 'command', command: 123}]}]}}, 'hooks.Stop[0].hooks[0].command'],
]
let malformedInputsRejected = true
for (const [settings, location] of malformedCodexSettings) {
  const before = structuredClone(settings)
  try {
    withCodexTermHooks(settings, codexRelay)
    malformedInputsRejected = false
  } catch (error) {
    malformedInputsRejected &&= error instanceof Error &&
      error.message.includes('Codex hooks.json') && error.message.includes(location)
  }
  malformedInputsRejected &&= eq(settings, before)
}
check(malformedInputsRejected, 'Codex の不正な hooks 構造は入力を変更せず説明付きエラーで拒否する')

console.log(pass ? 'HOOKS SMOKE PASS' : 'HOOKS SMOKE FAIL')
process.exit(pass ? 0 : 1)
