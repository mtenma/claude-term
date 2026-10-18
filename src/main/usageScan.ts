import {createHash} from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {AgentKind} from '../shared/types'
import {CodexFileParser, emptyCodexState, parseClaudeLine, type CodexState, type ParsedLines} from './usageParse'
import {resolveProject, type ProjectInfo, type ResolveOptions} from './usageProject'
import type {FileRecord, UsageStore} from './usageStore'

export interface ScanRoots {
  claude: string[]
  codex: string[]
}

export interface ScanOptions {
  roots: ScanRoots
  store: UsageStore
  resolve: ResolveOptions
  now?: () => number
  onProgress?: (doneBytes: number, totalBytes: number) => void
}

export interface ScanResult {
  parseErrors: number
  longLines: number
  unreadable: number
  /** この回で読んだバイト数 */
  readBytes: number
}

const CHUNK = 1024 * 1024
const MAX_LINE = 8 * 1024 * 1024
const HEAD = 4096
const MAX_DEPTH = 6
// record だけが残ったファイルは、この時間更新がなければ record を 1 回分として数える
const PENDING_GRACE_MS = 10 * 60_000

const yieldToEvents = () => new Promise<void>((resolve) => setImmediate(resolve))

interface Candidate {
  path: string
  agent: AgentKind
  ident: string
  size: number
  mtime: number
}

/** 記録フォルダの .jsonl を集める。シンボリックリンクと通常ファイル以外は読まない */
function listFiles(root: string, agent: AgentKind, out: Candidate[], depth = 0): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, {withFileTypes: true})
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) listFiles(full, agent, out, depth + 1)
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const stat = fs.lstatSync(full, {bigint: true})
        if (!stat.isFile()) continue
        out.push({
          path: full,
          agent,
          ident: `${stat.dev}:${stat.ino}`,
          size: Number(stat.size),
          mtime: Number(stat.mtimeMs),
        })
      } catch {
        // 列挙中に消えたファイルは次回に回す
      }
    }
  }
}

/** 記録フォルダ自体のシンボリックリンクだけは 1 回たどる(dotfiles 管理などで置き換えている場合) */
function realRoot(root: string): string | null {
  try {
    const stat = fs.lstatSync(root)
    if (stat.isDirectory()) return root
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync(root)
      return fs.statSync(target).isDirectory() ? target : null
    }
  } catch {
    // 記録フォルダがない(そのエージェントを使っていない)
  }
  return null
}

const hashHead = (fd: number, length: number): string => {
  const buffer = Buffer.alloc(length)
  const read = fs.readSync(fd, buffer, 0, length, 0)
  return createHash('sha256').update(buffer.subarray(0, read)).digest('hex')
}

/** 前回の続きから読めるか。同じ inode で、先頭と区切り位置が変わっていないことを確かめる */
function resumeOffset(fd: number, file: Candidate, stored: FileRecord | undefined): number {
  if (!stored || stored.ident !== file.ident || file.size < stored.offset || stored.offset === 0) return 0
  if (hashHead(fd, stored.headLen) !== stored.headHash) return 0
  const previous = Buffer.alloc(1)
  if (fs.readSync(fd, previous, 0, 1, stored.offset - 1) !== 1 || previous[0] !== 0x0a) return 0
  return stored.offset
}

interface ReadResult {
  offset: number
  longLines: number
}

/**
 * offset から size までの完全な行を順に渡す。末尾の改行がない行(書込み途中)は次回に回す。
 * MAX_LINE を超える行は次の改行まで読み捨て、件数だけ数える
 */
function readLines(fd: number, offset: number, size: number, onLine: (line: string) => void,
  onBytes: (bytes: number) => void): ReadResult {
  const buffer = Buffer.alloc(CHUNK)
  let parts: Buffer[] = []
  let partLength = 0
  let skipping = false
  let longLines = 0
  let position = offset
  let consumed = offset
  while (position < size) {
    const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position)
    if (read <= 0) break
    const chunk = buffer.subarray(0, read)
    let start = 0
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      if (!skipping) {
        const piece = chunk.subarray(start, newline)
        const line = partLength ? Buffer.concat([...parts, piece]).toString('utf8') : piece.toString('utf8')
        onLine(line)
      }
      skipping = false
      parts = []
      partLength = 0
      start = newline + 1
      consumed = position + start
    }
    if (start < read && !skipping) {
      partLength += read - start
      if (partLength > MAX_LINE) {
        skipping = true
        longLines++
        parts = []
        partLength = 0
      } else {
        parts.push(Buffer.from(chunk.subarray(start)))
      }
    }
    position += read
    onBytes(read)
  }
  return {offset: consumed, longLines}
}

export async function scanUsage(options: ScanOptions): Promise<ScanResult> {
  const {store} = options
  const now = options.now ?? Date.now
  const result: ScanResult = {parseErrors: 0, longLines: 0, unreadable: 0, readBytes: 0}
  const candidates: Candidate[] = []
  for (const agent of ['claude', 'codex'] as const) {
    for (const root of options.roots[agent]) {
      const real = realRoot(root)
      if (real) listFiles(real, agent, candidates)
    }
  }

  const stored = store.allFiles()
  const changed = candidates.filter((file) => {
    const previous = stored.get(file.path)
    if (!previous) return true
    if (previous.ident !== file.ident || previous.size !== file.size || previous.mtime !== file.mtime) return true
    // 変化のない Codex の記録でも、record だけが残ったまま時間が過ぎたら数える
    return file.agent === 'codex' && previous.state.includes('"pending":{') && now() - file.mtime > PENDING_GRACE_MS
  })
  const totalBytes = changed.reduce((sum, file) => sum + Math.max(0, file.size - (stored.get(file.path)?.offset ?? 0)), 0)
  let doneBytes = 0
  let lastProgress = 0
  const progress = (bytes: number) => {
    doneBytes += bytes
    result.readBytes += bytes
    const t = now()
    if (t - lastProgress >= 100) {
      lastProgress = t
      options.onProgress?.(Math.min(doneBytes, totalBytes), totalBytes)
    }
  }
  options.onProgress?.(0, totalBytes)

  for (const file of changed) {
    const previous = stored.get(file.path)
    let fd: number | undefined
    try {
      fd = fs.openSync(file.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
      if (!fs.fstatSync(fd).isFile()) throw new Error('not a regular file')
      const offset = resumeOffset(fd, file, previous)
      const resumed = offset > 0 && previous !== undefined
      let state: CodexState = emptyCodexState()
      if (resumed && file.agent === 'codex') {
        try {
          state = {...emptyCodexState(), ...JSON.parse(previous.state) as CodexState}
        } catch {
          state = emptyCodexState()
        }
      }
      const parsed: ParsedLines = {rows: [], starts: [], parseErrors: 0}
      const codex = new CodexFileParser(state)
      const onLine = file.agent === 'claude'
        ? (line: string) => parseClaudeLine(line, parsed)
        : (line: string) => codex.line(line)
      const read = readLines(fd, offset, file.size, onLine, progress)
      if (file.agent === 'codex' && now() - file.mtime > PENDING_GRACE_MS) codex.flushPending()
      const out = file.agent === 'claude' ? parsed : codex.out
      const headLen = Math.min(HEAD, file.size)
      const committed = store.commitFile({
        path: file.path,
        agent: file.agent,
        ident: file.ident,
        size: file.size,
        mtime: file.mtime,
        offset: read.offset,
        headLen,
        headHash: hashHead(fd, headLen),
        state: file.agent === 'codex' ? JSON.stringify(codex.state) : '',
      }, previous?.offset ?? null, out.rows, out.starts)
      if (committed) {
        result.parseErrors += out.parseErrors
        result.longLines += read.longLines
      }
    } catch (error) {
      // DB の失敗は呼出元へ。ファイルの読込み失敗は件数だけ数える(本文を含み得る文面は出さない)
      if ((error as {code?: string}).code === 'ERR_SQLITE_ERROR') throw error
      result.unreadable++
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    await yieldToEvents()
  }
  options.onProgress?.(totalBytes, totalBytes)

  const projects = new Map<string, ProjectInfo>()
  for (const cwd of store.unresolvedCwds()) projects.set(cwd, resolveProject(cwd, options.resolve))
  store.saveProjects(projects)
  store.setMeta('lastScanAt', now())
  store.restrictPermissions()
  return result
}
