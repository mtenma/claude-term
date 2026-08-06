// hooksSettings.ts(~/.claude/settings.json へのマージロジック)の機械検証。
// ユーザーの設定ファイルを書き換えるコードなので、冪等性と既存設定の保全を必ず確認する。
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

await esbuild.build({
  entryPoints: ['src/main/hooksSettings.ts'],
  outfile: 'dist-test/hooksSettings.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'silent',
})

const {withClaudeTermHooks, MARKER, SL_MARKER, DESIRED} = require(
  path.join(root, 'dist-test/hooksSettings.cjs'),
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
    SessionStart: [{hooks: [{type: 'command', command: 'echo hello'}]}],
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
check(eq(merged.hooks.SessionStart, userSettings.hooks.SessionStart), '無関係なイベントは不変')
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

console.log(pass ? 'HOOKS SMOKE PASS' : 'HOOKS SMOKE FAIL')
process.exit(pass ? 0 : 1)
