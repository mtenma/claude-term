import * as fs from 'node:fs'
import * as path from 'node:path'

export interface ProjectInfo {
  /** プロジェクトの根(一時フォルダは空) */
  root: string
  kind: 'git' | 'dir' | 'temp'
}

export interface ResolveOptions {
  home: string
  tempPrefixes?: readonly string[]
}

const TEMP_PREFIXES = ['/private/var/folders/', '/var/folders/', '/private/tmp/', '/tmp/']
// 応答しないネットワークボリュームで stat が止まらないよう、外部の場所はたどらない
const UNTRAVERSED = ['/Volumes/', '/Network/']
const GIT_FILE_LIMIT = 4096

/** .git が通常ファイル(ワークツリー・submodule)なら gitdir の指す先を返す */
function readGitFile(gitPath: string): string | null {
  let fd: number | undefined
  try {
    // FIFO などで止まらないよう、通常ファイルで小さいものだけを読む
    fd = fs.openSync(gitPath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > GIT_FILE_LIMIT) return null
    const buffer = Buffer.alloc(stat.size)
    const content = buffer.subarray(0, fs.readSync(fd, buffer, 0, stat.size, 0)).toString('utf8')
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(content)
    return match ? path.resolve(path.dirname(gitPath), match[1]) : null
  } catch {
    return null
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

/** dir に .git があればプロジェクトの根を返す */
function gitRootAt(dir: string): string | null {
  const gitPath = path.join(dir, '.git')
  let stat: fs.Stats | undefined
  try {
    stat = fs.lstatSync(gitPath, {throwIfNoEntry: false})
  } catch {
    return null // 権限がないフォルダは「見つからない」として扱う
  }
  if (!stat) return null
  if (stat.isDirectory()) return dir
  if (!stat.isFile()) return null
  const gitdir = readGitFile(gitPath)
  if (!gitdir) return null
  // ワークツリーは元のリポジトリにまとめる。submodule(.git/modules)はそれ自身を根とする
  const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`
  const index = gitdir.indexOf(marker)
  return index > 0 ? gitdir.slice(0, index) : dir
}

/**
 * 作業フォルダからプロジェクトを決める。
 * 一時フォルダ → .claude/worktrees の手前 → 親へたどって .git → 見つからなければ作業フォルダ自身。
 * ホームより上と外部ボリュームはたどらない(ホーム直下の dotfiles リポジトリに全体が入るのも防ぐ)
 */
export function resolveProject(cwd: string, options: ResolveOptions): ProjectInfo {
  if (!path.isAbsolute(cwd)) return {root: cwd, kind: 'dir'}
  const normalized = path.normalize(cwd)
  const temps = options.tempPrefixes ?? TEMP_PREFIXES
  if (temps.some((prefix) => `${normalized}/`.startsWith(prefix))) return {root: '', kind: 'temp'}
  if (UNTRAVERSED.some((prefix) => normalized.startsWith(prefix))) return {root: normalized, kind: 'dir'}

  const worktree = normalized.indexOf('/.claude/worktrees/')
  const start = worktree > 0 ? normalized.slice(0, worktree) : normalized
  const home = path.normalize(options.home)
  const underHome = start === home || start.startsWith(`${home}${path.sep}`)
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (underHome ? dir === home : dir === path.dirname(dir)) break
    const root = gitRootAt(dir)
    if (root) return {root, kind: 'git'}
  }
  return {root: start, kind: 'dir'}
}
