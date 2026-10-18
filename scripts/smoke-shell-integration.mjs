// 実ユーザーの設定を読まず、起動ファイル消失後も同じアプリ内で復旧するか検証する。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {createRequire} from 'node:module'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import * as vm from 'node:vm'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const built = await esbuild.build({
  absWorkingDir: root, entryPoints: ['src/main/shellIntegration.ts'],
  bundle: true, platform: 'node', format: 'cjs', target: 'node22',
  packages: 'external', write: false, logLevel: 'silent',
})
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-term-shell-smoke-'))
const config = path.join(temporary, 'user config')
fs.mkdirSync(config)
for (const [file, name] of [['.zshenv', 'env'], ['.zprofile', 'profile'], ['.zshrc', 'rc'], ['.zlogin', 'login']]) {
  fs.writeFileSync(path.join(config, file), `unset HISTFILE\nexport CLAUDE_TERM_TEST_TRACE="\${CLAUDE_TERM_TEST_TRACE-}${name},"\n`)
}
const cleanups = []
let failWrite = false
const module = {exports: {}}
vm.runInNewContext(built.outputFiles[0].text, {
  module, exports: module.exports,
  require: (name) => {
    if (name === 'node:os') return {...os, tmpdir: () => temporary}
    if (name === 'node:fs') return {...fs, writeFileSync: (...args) => {
      if (failWrite) throw Object.assign(new Error('write failed'), {code: 'EACCES'})
      return fs.writeFileSync(...args)
    }}
    return require(name)
  },
  process: {once: (event, callback) => { assert.equal(event, 'exit'); cleanups.push(callback) }},
  console: {warn() {}},
})
const {configureShellIntegration} = module.exports
function launch() {
  const env = {PATH: '/usr/bin:/bin', ZDOTDIR: config}
  configureShellIntegration('/bin/zsh', env)
  const result = spawnSync('/bin/zsh', ['-lic', 'printf "%s" "$CLAUDE_TERM_TEST_TRACE"'], {
    env, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(result.status, 0, String(result.error ?? result.stderr))
  assert.equal(result.stdout, 'env,profile,rc,login,')
  return env
}

try {
  const first = launch()
  assert.equal(first.CLAUDE_TERM_ORIGINAL_ZDOTDIR, config)
  assert.equal(launch().ZDOTDIR, first.ZDOTDIR, '正常な起動ファイルは再利用する')
  let previous = first.ZDOTDIR
  for (const failure of ['file', 'directory', 'empty', ...Array(10).fill('file')]) {
    if (failure === 'directory') fs.rmSync(previous, {recursive: true})
    else if (failure === 'empty') fs.writeFileSync(path.join(previous, '.zshenv'), '')
    else fs.unlinkSync(path.join(previous, '.zshenv'))
    const next = launch()
    assert.notEqual(next.ZDOTDIR, previous, '削除・破損したファイルを参照し続けない')
    previous = next.ZDOTDIR
  }
  assert.equal(cleanups.length, 1, '再作成を繰り返しても終了リスナーを増やさない')
  console.log('ok   .zshenv・ディレクトリの消失や空ファイル化から再起動なしで復旧し、設定の読込順を保持')

  fs.unlinkSync(path.join(previous, '.zshenv'))
  failWrite = true
  assert.deepEqual(launch(), {PATH: '/usr/bin:/bin', ZDOTDIR: config}, '準備失敗時は元の環境で通常起動する')
  failWrite = false
  assert.notEqual(launch().ZDOTDIR, config, '書込みが回復したら連携も復旧する')
  console.log('ok   一時ファイルの書込失敗でもユーザーの zsh 設定は読み込める')
} finally {
  for (const cleanup of cleanups) cleanup()
  fs.rmSync(temporary, {recursive: true, force: true})
}
console.log('SHELL INTEGRATION SMOKE PASS')
