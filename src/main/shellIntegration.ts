import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// 対話シェル内の codex にだけ通知先を付ける。引数・終了コードは元の CLI に従う。
// 設定の実行時上書きは、Codex の暗黙の共有サーバーによる通知先の混線を防ぐ。
export const CODEX_FUNCTION_BODY = String.raw`(
  if [ "${'$'}{CLAUDE_TERM_CODEX-}" = "1" ] || [ -z "${'$'}{CLAUDE_TERM_PORT-}" ] || [ -z "${'$'}{CLAUDE_TERM_SESSION-}" ]; then
    command codex "$@"
    return $?
  fi
  export CLAUDE_TERM_CODEX=1
  # hook の信頼状態とは別に、この CLI 呼出の開始と終了だけを通知する。
  claude_term_codex_run_id=$(/usr/bin/uuidgen 2>/dev/null) || claude_term_codex_run_id=
  if [ -n "$claude_term_codex_run_id" ]; then
    /usr/bin/curl -s -m 1 -X POST \
      "http://127.0.0.1:$CLAUDE_TERM_PORT/codex-process/$CLAUDE_TERM_SESSION/$claude_term_codex_run_id/start" >/dev/null 2>&1 || :
  fi
  if command codex -c "shell_environment_policy.set.CLAUDE_TERM_PORT=\"$CLAUDE_TERM_PORT\"" \
      -c "shell_environment_policy.set.CLAUDE_TERM_SESSION=\"$CLAUDE_TERM_SESSION\"" "$@"; then
    claude_term_codex_rc=0
  else
    claude_term_codex_rc=$?
  fi
  if [ -n "$claude_term_codex_run_id" ]; then
    /usr/bin/curl -s -m 1 -X POST \
      "http://127.0.0.1:$CLAUDE_TERM_PORT/codex-process/$CLAUDE_TERM_SESSION/$claude_term_codex_run_id/exit" >/dev/null 2>&1 || :
  else
    /usr/bin/curl -s -m 1 -X POST \
      "http://127.0.0.1:$CLAUDE_TERM_PORT/codex-exit/$CLAUDE_TERM_SESSION" >/dev/null 2>&1 || :
  fi
  exit "$claude_term_codex_rc"
)`

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`
let zshDirectory: string | undefined

function getZshDirectory(): string {
  if (zshDirectory) return zshDirectory
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-term-shell-'))
  // ZDOTDIR を戻してからユーザーの .zshenv を読むので、後続の .zprofile/.zshrc/
  // .zlogin/.zlogout も本来の場所・順序で読み込まれる。ユーザーのファイルは書き換えない。
  const script = `if [[ -n \${CLAUDE_TERM_ORIGINAL_ZDOTDIR+x} ]]; then
  export ZDOTDIR="$CLAUDE_TERM_ORIGINAL_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset CLAUDE_TERM_ORIGINAL_ZDOTDIR
if [[ -r "\${ZDOTDIR-$HOME}/.zshenv" ]]; then
  source "\${ZDOTDIR-$HOME}/.zshenv"
fi
if [[ -o interactive && -z \${functions[codex]-} ]]; then
  functions[codex]=${shellQuote(CODEX_FUNCTION_BODY)}
fi
`
  fs.writeFileSync(path.join(directory, '.zshenv'), script, {mode: 0o600})
  zshDirectory = directory
  process.once('exit', () => {
    try {
      fs.rmSync(directory, {recursive: true, force: true})
    } catch {
      // 一時ファイルの後片付けで終了を妨げない。
    }
  })
  return directory
}

/** 起動するシェルの環境だけに連携を追加する。既存の別ターミナルには影響しない。 */
export function configureShellIntegration(shell: string, env: Record<string, string>): void {
  const name = path.basename(shell)
  if (name === 'zsh') {
    if (env.ZDOTDIR !== undefined) env.CLAUDE_TERM_ORIGINAL_ZDOTDIR = env.ZDOTDIR
    else delete env.CLAUDE_TERM_ORIGINAL_ZDOTDIR
    env.ZDOTDIR = getZshDirectory()
  } else if (name === 'bash') {
    // Bash はログイン設定を通常通り読みつつ、export された関数を取り込める。
    env['BASH_FUNC_codex%%'] ??= `() { ${CODEX_FUNCTION_BODY}\n}`
  }
}
