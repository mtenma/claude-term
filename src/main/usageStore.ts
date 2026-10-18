import * as fs from 'node:fs'
import {DatabaseSync, type SQLInputValue} from 'node:sqlite'
import type {AgentKind, UsageErrorCode} from '../shared/types'
import type {SessionStart, UsageRow} from './usageParse'
import type {ProjectInfo} from './usageProject'

export const SCHEMA_VERSION = 1
const BUCKET_MS = 15 * 60_000

export class UsageStoreError extends Error {
  constructor(readonly code: UsageErrorCode) {
    super(code)
  }
}

/** 取込み済みの位置。同じ inode・先頭のまま大きくなったファイルは続きから読む */
export interface FileRecord {
  path: string
  agent: AgentKind
  ident: string
  size: number
  mtime: number
  offset: number
  headLen: number
  headHash: string
  state: string
}

/** 集計の単位(UTC の 15 分枠 × プロジェクト × 料金の区分) */
export interface UsageGroup {
  bucket: number
  agent: AgentKind
  model: string
  speed: string
  geo: string
  longContext: number
  root: string
  kind: string
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
  webSearch: number
  last: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS requests (
  key TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL,
  cache_write_5m INTEGER NOT NULL,
  cache_write_1h INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  output INTEGER NOT NULL,
  web_search INTEGER NOT NULL,
  speed TEXT NOT NULL,
  geo TEXT NOT NULL,
  prompt INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS requests_ts ON requests (ts);
CREATE TABLE IF NOT EXISTS sessions (
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  start_cwd TEXT NOT NULL,
  PRIMARY KEY (agent, session_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS projects (
  cwd TEXT PRIMARY KEY,
  root TEXT NOT NULL,
  kind TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  ident TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  head_len INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  state TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;
`

// 同じ呼出しが複数の行・ファイルにある場合: トークンは大きいほう(書込み途中の値を避ける)、
// セッション・モデルは時刻の早いほう(fork したファイルの写しより親を優先)を残す。
// speed・geo は Claude では同じ応答の最後の行にだけ書かれるため、空でない値を優先する。行は消さない
const UPSERT_REQUEST = `
INSERT INTO requests (key, agent, session_id, ts, model, input, cache_write_5m, cache_write_1h,
  cache_read, output, web_search, speed, geo, prompt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET
  input = max(input, excluded.input),
  cache_write_5m = max(cache_write_5m, excluded.cache_write_5m),
  cache_write_1h = max(cache_write_1h, excluded.cache_write_1h),
  cache_read = max(cache_read, excluded.cache_read),
  output = max(output, excluded.output),
  web_search = max(web_search, excluded.web_search),
  prompt = max(prompt, excluded.prompt),
  session_id = CASE WHEN session_id = '' OR (excluded.ts < ts AND excluded.session_id <> '')
    THEN excluded.session_id ELSE session_id END,
  model = CASE WHEN model = '' OR (excluded.ts < ts AND excluded.model <> '')
    THEN excluded.model ELSE model END,
  speed = CASE WHEN speed = '' OR (excluded.ts < ts AND excluded.speed <> '')
    THEN excluded.speed ELSE speed END,
  geo = CASE WHEN geo = '' OR (excluded.ts < ts AND excluded.geo <> '')
    THEN excluded.geo ELSE geo END,
  ts = min(ts, excluded.ts)
`

const UPSERT_SESSION = `
INSERT INTO sessions (agent, session_id, start_ts, start_cwd) VALUES (?, ?, ?, ?)
ON CONFLICT (agent, session_id) DO UPDATE SET
  start_cwd = CASE WHEN excluded.start_ts < start_ts THEN excluded.start_cwd ELSE start_cwd END,
  start_ts = min(start_ts, excluded.start_ts)
`

const UPSERT_FILE = `
INSERT INTO files (path, agent, ident, size, mtime, offset, head_len, head_hash, state)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (path) DO UPDATE SET agent = excluded.agent, ident = excluded.ident, size = excluded.size,
  mtime = excluded.mtime, offset = excluded.offset, head_len = excluded.head_len,
  head_hash = excluded.head_hash, state = excluded.state
`

const sqliteCode = (error: unknown): number =>
  typeof (error as {errcode?: unknown}).errcode === 'number' ? (error as {errcode: number}).errcode & 0xff : -1
const SQLITE_CORRUPT = 11
const SQLITE_NOTADB = 26

const SIDE_FILES = ['', '-wal', '-shm', '-journal']

/** 本体と付属ファイルを 0600 にそろえる。SQLite は付属ファイルを本体と同じ権限で作る */
function restrictPermissions(file: string): void {
  for (const suffix of SIDE_FILES) {
    try {
      fs.chmodSync(file + suffix, 0o600)
    } catch {
      // まだ作られていない付属ファイルは対象外
    }
  }
}

function createPrivateFile(file: string): void {
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/** 壊れた DB は消さずに退避する。元の記録が消えた分は、この DB が唯一の写しのため */
function moveAside(file: string): void {
  const suffix = `.broken-${Date.now()}`
  for (const side of SIDE_FILES) {
    try {
      fs.renameSync(file + side, file + suffix + side)
    } catch {
      // 存在しない付属ファイルは対象外
    }
  }
}

export class UsageStore {
  private db: DatabaseSync

  constructor(readonly file: string) {
    this.db = this.open()
  }

  private open(retry = true): DatabaseSync {
    // シンボリックリンクなどをたどって別のファイルを書き換え・退避しない
    const existing = fs.lstatSync(this.file, {throwIfNoEntry: false})
    if (existing && !existing.isFile()) throw new UsageStoreError('db_failed')
    createPrivateFile(this.file)
    const db = new DatabaseSync(this.file, {timeout: 10_000})
    try {
      db.exec('PRAGMA journal_mode = WAL')
      const check = db.prepare('PRAGMA quick_check').get() as {quick_check?: string} | undefined
      if (check?.quick_check !== 'ok') throw Object.assign(new Error('corrupt'), {errcode: SQLITE_CORRUPT})
      const version = (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version
      if (version > SCHEMA_VERSION) throw new UsageStoreError('db_newer')
      if (version < SCHEMA_VERSION) {
        db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`)
      }
    } catch (error) {
      db.close()
      const code = sqliteCode(error)
      if (retry && (code === SQLITE_CORRUPT || code === SQLITE_NOTADB)) {
        moveAside(this.file)
        return this.open(false)
      }
      throw error instanceof UsageStoreError ? error : new UsageStoreError('db_failed')
    }
    restrictPermissions(this.file)
    return db
  }

  close(): void {
    if (this.db.isOpen) this.db.close()
  }

  restrictPermissions(): void {
    restrictPermissions(this.file)
  }

  allFiles(): Map<string, FileRecord> {
    const rows = this.db.prepare(`SELECT path, agent, ident, size, mtime, offset, head_len AS headLen,
      head_hash AS headHash, state FROM files`).all() as unknown as FileRecord[]
    return new Map(rows.map((row) => [row.path, {...row}]))
  }

  /**
   * 1 ファイル分の取込み結果を 1 つのトランザクションで書く。読み始めた位置が他の書込み
   * (開発版とパッケージ版の同時実行など)で進んでいたら何も書かずに false を返す
   */
  commitFile(record: FileRecord, expectedOffset: number | null, rows: UsageRow[], starts: SessionStart[]): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT offset FROM files WHERE path = ?').get(record.path) as
        {offset: number} | undefined
      if ((current?.offset ?? null) !== expectedOffset) {
        this.db.exec('ROLLBACK')
        return false
      }
      const upsertRequest = this.db.prepare(UPSERT_REQUEST)
      for (const r of rows) {
        upsertRequest.run(r.key, r.agent, r.sessionId, r.ts, r.model, r.input, r.cacheWrite5m, r.cacheWrite1h,
          r.cacheRead, r.output, r.webSearch, r.speed, r.geo, r.prompt)
      }
      const upsertSession = this.db.prepare(UPSERT_SESSION)
      for (const s of starts) upsertSession.run(s.agent, s.sessionId, s.ts, s.cwd)
      this.db.prepare(UPSERT_FILE).run(record.path, record.agent, record.ident, record.size, record.mtime,
        record.offset, record.headLen, record.headHash, record.state)
      this.db.exec('COMMIT')
      return true
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** プロジェクトをまだ決めていない「セッションを始めたフォルダ」 */
  unresolvedCwds(): string[] {
    const rows = this.db.prepare(`SELECT DISTINCT s.start_cwd AS cwd FROM sessions s
      LEFT JOIN projects p ON p.cwd = s.start_cwd WHERE p.cwd IS NULL`).all() as {cwd: string}[]
    return rows.map((row) => row.cwd)
  }

  /** 最初に決めた結果を保存し、後でフォルダが消えても過去の分のまとまり方を変えない */
  saveProjects(projects: Map<string, ProjectInfo>): void {
    if (projects.size === 0) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare('INSERT OR IGNORE INTO projects (cwd, root, kind) VALUES (?, ?, ?)')
      for (const [cwd, info] of projects) insert.run(cwd, info.root, info.kind)
      this.db.exec('COMMIT')
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** longContext は、1 回の入力がエージェントごとの境目を超えた呼出し */
  groups(start: number, end: number, limits: Record<AgentKind, number>): UsageGroup[] {
    return this.db.prepare(`
      SELECT r.ts / ${BUCKET_MS} AS bucket, r.agent, r.model, r.speed, r.geo,
        (r.prompt > CASE r.agent WHEN 'codex' THEN ? ELSE ? END) AS longContext,
        COALESCE(p.root, s.start_cwd, '') AS root, COALESCE(p.kind, 'unknown') AS kind,
        SUM(r.input) AS input, SUM(r.cache_write_5m) AS cacheWrite5m, SUM(r.cache_write_1h) AS cacheWrite1h,
        SUM(r.cache_read) AS cacheRead, SUM(r.output) AS output, SUM(r.web_search) AS webSearch,
        MAX(r.ts) AS last
      FROM requests r
      LEFT JOIN sessions s ON s.agent = r.agent AND s.session_id = r.session_id
      LEFT JOIN projects p ON p.cwd = s.start_cwd
      WHERE r.ts >= ? AND r.ts < ?
      GROUP BY bucket, r.agent, r.model, r.speed, r.geo, longContext, root, kind
    `).all(limits.codex, limits.claude, start, end) as unknown as UsageGroup[]
  }

  earliest(): Record<AgentKind, number | null> {
    const rows = this.db.prepare('SELECT agent, MIN(ts) AS ts FROM requests GROUP BY agent').all() as
      {agent: AgentKind; ts: number}[]
    const out: Record<AgentKind, number | null> = {claude: null, codex: null}
    for (const row of rows) out[row.agent] = row.ts
    return out
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as {value: string} | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: SQLInputValue): void {
    this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, String(value))
  }
}
