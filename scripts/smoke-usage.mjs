// コスト画面の取込み・集計の検証。偽の記録と一時 DB だけを使い、実ユーザーの記録は読まない。
// 期待値の金額は src/main/usagePricing.ts の単価から手で計算した値。
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import {execFileSync} from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

process.env.TZ = 'Asia/Tokyo'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const work = path.join(root, 'dist-test', `usage-smoke-${process.pid}`)
fs.rmSync(work, {recursive: true, force: true})
fs.mkdirSync(work, {recursive: true})
process.on('exit', () => fs.rmSync(work, {recursive: true, force: true}))

const bundle = path.join(work, 'usage.mjs')
await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: `export * from './src/main/usageScan'
export * from './src/main/usageStore'
export * from './src/main/usageReport'
export * from './src/main/usagePricing'
export * from './src/main/usageProject'
export * as view from './src/renderer/costModel'`,
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: bundle, logLevel: 'silent',
})
const U = await import(pathToFileURL(bundle).href)

let failures = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}
const near = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`)

// ---- 偽の記録 ----
const fx = path.join(work, 'fx')
const home = path.join(fx, 'home')
const alpha = path.join(home, 'work', 'alpha')
const beta = path.join(home, 'work', 'beta')
const worktree = path.join(home, 'work', 'wt')
const notes = path.join(home, 'notes', 'sub')
const temp = path.join(fx, 'tmp', 'x')
for (const dir of [path.join(alpha, '.git', 'worktrees', 'wt'), path.join(beta, '.git'), worktree, notes, temp]) {
  fs.mkdirSync(dir, {recursive: true})
}
fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(alpha, '.git', 'worktrees', 'wt')}\n`)
const claudeRoot = path.join(fx, 'claude', 'projects')
const codexRoot = path.join(fx, 'codex', 'sessions')
const archivedRoot = path.join(fx, 'codex', 'archived_sessions')
const resolve = {home, tempPrefixes: [path.join(fx, 'tmp') + '/']}
const NOW = Date.parse('2026-10-18T03:00:00Z') // 10/18 12:00 JST

const jsonl = (lines) => lines.map((l) => typeof l === 'string' ? l : JSON.stringify(l)).join('\n') + '\n'
function write(file, lines, {newline = true} = {}) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  const text = jsonl(lines)
  fs.writeFileSync(file, newline ? text : text.slice(0, -1))
}
const assistant = (id, ts, cwd, sessionId, model, usage, extra = {}) => ({
  type: 'assistant', sessionId, cwd, timestamp: ts, requestId: `req-${id}`,
  message: {id: `msg-${id}`, model, usage}, ...extra,
})
const usage = ({input = 0, cw5 = 0, cw1h = 0, read = 0, out = 0, ...rest}) => ({
  input_tokens: input, cache_creation_input_tokens: cw5 + cw1h, cache_read_input_tokens: read, output_tokens: out,
  cache_creation: {ephemeral_5m_input_tokens: cw5, ephemeral_1h_input_tokens: cw1h}, ...rest,
})

const s1 = path.join(claudeRoot, '-alpha', 's1.jsonl')
const m4 = assistant(4, '2026-10-18T02:30:00Z', alpha, 's1', 'claude-sonnet-5-5', usage({read: 10000, out: 100}))
write(s1, [
  {type: 'user', sessionId: 's1', cwd: alpha, timestamp: '2026-10-17T14:00:00Z', message: {content: '秘密の本文'}},
  assistant(1, '2026-10-18T01:00:00Z', alpha, 's1', 'claude-opus-5-5', usage({input: 1000, cw5: 2000, read: 100000, out: 10})),
  assistant(1, '2026-10-18T01:00:00Z', alpha, 's1', 'claude-opus-5-5', usage({input: 1000, cw5: 2000, read: 100000, out: 500})),
  assistant(2, '2026-10-17T14:50:00Z', alpha, 's1', 'claude-haiku-4-5-20251001', usage({input: 100, cw1h: 1000, out: 200})),
  // 途中で別のリポジトリへ移っても、セッションを始めたフォルダ(alpha)に数える
  assistant(3, '2026-10-18T02:00:00Z', beta, 's1', 'claude-opus-5-5',
    usage({input: 1000, out: 1000, speed: 'fast', inference_geo: 'us', server_tool_use: {web_search_requests: 3}})),
  assistant('syn', '2026-10-18T02:10:00Z', alpha, 's1', '<synthetic>', usage({input: 5, out: 5})),
  '{"type":"assistant","usage": 秘密の本文',
  m4,
], {newline: false})
write(path.join(claudeRoot, '-alpha', 's1', 'subagents', 'agent-1.jsonl'), [
  assistant(1, '2026-10-18T01:00:00Z', path.join(alpha, '.claude', 'worktrees', 'agent-1'), 's1', 'claude-opus-5-5',
    usage({input: 1000, cw5: 2000, read: 100000, out: 500})),
  assistant(5, '2026-10-18T01:30:00Z', alpha, 's1', 'claude-mystery-9', usage({input: 50, out: 50})),
])
write(path.join(claudeRoot, '-wt', 's2.jsonl'), [
  assistant(6, '2026-10-16T03:00:00Z', worktree, 's2', 'claude-opus-4-7', usage({input: 1000, out: 100})),
])
const s3 = path.join(claudeRoot, '-notes', 's3.jsonl')
write(s3, [assistant(7, '2026-10-15T03:00:00Z', notes, 's3', 'claude-sonnet-5', usage({read: 1000}))])
write(path.join(claudeRoot, '-tmp', 's4.jsonl'), [
  assistant(8, '2026-10-18T00:00:00Z', temp, 's4', 'claude-haiku-4-5', usage({input: 10, out: 10})),
])

const tc = (ts, total, last) => ({
  type: 'event_msg', timestamp: ts,
  payload: {type: 'token_count', info: {total_token_usage: total, last_token_usage: last ?? total}},
})
const u = (input, cached, out, reasoning = 0) =>
  ({input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: out,
    reasoning_output_tokens: reasoning, total_tokens: input + out})
const meta = (ts, id, cwd, extra = {}) => ({type: 'session_meta', timestamp: ts, payload: {id, cwd, ...extra}})
const turn = (model) => ({type: 'turn_context', timestamp: '2026-10-17T00:00:00Z', payload: {model}})
const rec = (ts, id, use) => ({type: 'token_usage_record', timestamp: ts, payload: {response_id: id, usage: use}})

const t1 = u(1000, 400, 100, 10)
const t2total = u(3000, 1400, 300, 20)
const t2last = u(2000, 1000, 200, 10)
write(path.join(codexRoot, '2026', '10', '17', 'rollout-a.jsonl'), [
  meta('2026-10-17T00:00:00Z', 'x1', alpha),
  turn('gpt-5.6-sol'),
  tc('2026-10-17T00:01:00Z', t1),
  tc('2026-10-17T00:01:30Z', t1),
  tc('2026-10-17T00:02:00Z', t2total, t2last),
  tc('2026-10-17T00:03:00Z', u(500, 0, 50)), // 累計が戻る(last = total)
])
// fork したファイルは親の token_count を時刻を書き換えて写す。名前順で親より先に読まれる
write(path.join(codexRoot, '2026', '10', '17', 'rollout-0-fork.jsonl'), [
  meta('2026-10-17T05:00:00Z', 'x2', alpha, {forked_from_id: 'x1'}),
  meta('2026-10-17T00:00:00Z', 'x1', beta),
  tc('2026-10-17T05:00:01Z', t1),
  tc('2026-10-17T05:00:01Z', t2total, t2last),
  turn('gpt-6.1-sol'),
  tc('2026-10-17T05:00:05Z', u(3500, 1400, 350, 20), u(500, 0, 50)),
])
const x3 = path.join(codexRoot, '2026', '10', '18', 'rollout-c.jsonl')
write(x3, [
  meta('2026-10-18T00:00:00Z', 'x3', beta),
  turn('gpt-6-astra'),
  rec('2026-10-18T00:01:00Z', 'r1', u(1000, 0, 100)),
  tc('2026-10-18T00:01:00Z', u(1000, 0, 100)),
  rec('2026-10-18T00:02:00Z', 'r2', u(5000, 1000, 500)), // 文脈圧縮: 累計が変わらない
  tc('2026-10-18T00:02:00Z', u(1000, 0, 100), u(0, 0, 0)),
  rec('2026-10-18T00:03:00Z', 'r3', u(300000, 0, 1000)), // 272K 超
  tc('2026-10-18T00:03:00Z', u(301000, 0, 1100), u(300000, 0, 1000)),
  rec('2026-10-18T00:04:00Z', 'r4', u(100, 0, 10)), // 末尾に残る record
])
write(path.join(archivedRoot, 'rollout-d.jsonl'), [
  meta('2026-10-16T00:00:00Z', 'x4', alpha), turn('fugu'), tc('2026-10-16T00:01:00Z', u(100, 0, 10)),
])

const roots = {claude: [claudeRoot], codex: [codexRoot, archivedRoot]}
const dbFile = path.join(work, 'usage.sqlite')
const store = new U.UsageStore(dbFile)
const scan = (now = NOW) => U.scanUsage({roots, store, resolve, now: () => now})
const report = (period = '7d', now = NOW) => U.buildReport({store, period, now, home})
const byName = (r) => Object.fromEntries(r.projects.map((p) => [p.name, p]))
const cost = (p) => p.claude.cost + p.codex.cost

const first = await scan()

await check('料金表: 日付を外して完全一致し、opus-5-5 が opus-5 の単価にならない', () => {
  assert.equal(U.ratesFor('claude', 'claude-opus-5-5', '', '', false).cacheRead, 0.2)
  assert.equal(U.ratesFor('claude', 'claude-opus-5', '', '', false).cacheRead, 0.5)
  assert.equal(U.ratesFor('claude', 'claude-sonnet-5-5', '', '', false).cacheRead, 0.1)
  assert.equal(U.ratesFor('claude', 'claude-haiku-4-5-20251001', '', '', false).output, 5)
  assert.equal(U.ratesFor('claude', 'claude-opus-4-7', 'fast', '', false), null)
  near(U.ratesFor('claude', 'claude-opus-5-5', 'fast', 'us', false).output, 44, 'fast × us')
  assert.equal(U.ratesFor('codex', 'gpt-6-astra', '', '', true).input, 20)
  assert.equal(U.ratesFor('codex', 'fugu', '', '', false), null)
})

await check('初回: 壊れた行・<synthetic>・書込み途中の行を除いて取り込む', () => {
  assert.equal(first.parseErrors, 1)
  assert.equal(first.unreadable, 0)
})

await check('プロジェクト: セッション開始フォルダ・ワークツリー・git 管理外・一時フォルダで分ける', () => {
  const r = report()
  assert.deepEqual(r.projects.map((p) => [p.name, p.kind]),
    [['beta', 'git'], ['alpha', 'git'], ['sub', 'dir'], ['一時フォルダ', 'temp']])
  assert.equal(byName(r).alpha.path, '~/work/alpha')
  assert.equal(byName(r)['一時フォルダ'].path, '')
})

await check('Claude: 重複行は大きいほう、1 時間書込・fast×us・Web 検索の額', () => {
  const alphaProject = byName(report()).alpha
  // m1 0.044 + m2 0.0031 + m3 0.0828 + m6 0.0075(ワークツリー)
  near(alphaProject.claude.cost, 0.1374, 'alpha の Claude')
  // m5(料金表にないモデル)は額に含めず、トークンだけ数える
  assert.equal(alphaProject.claude.unknownTokens, 100)
  // トークン: キャッシュ読込を除く(m1 3500 + m2 1300 + m3 2000 + m5 100 + m6 1100)
  assert.equal(alphaProject.claude.tokens, 8000)
  assert.equal(alphaProject.claude.cacheRead, 100000)
})

await check('Codex: fork の写しを二重に数えず、親のモデルで計算する', () => {
  // x1: 0.00456 + 0.0084 + 0.003、x2 自身の 1 回 0.0015(gpt-6.1-sol)
  const codex = byName(report()).alpha.codex
  near(codex.cost, 0.01746, 'alpha の Codex')
  // 写しはモデル不明のまま数えると額に出ないため、トークンでも確かめる
  // (x1 700 + 1200 + 550、x2 自身 550、x4 110)
  assert.equal(codex.tokens, 3110)
})

await check('Codex: 文脈圧縮の record を足し、272K 超は長文脈の単価、末尾の record は保留', () => {
  // 0.015 + 0.066(r2) + 6.075(r3 長文脈)。r4 はまだ数えない
  near(byName(report()).beta.codex.cost, 6.156, 'beta の Codex')
})

await check('料金不明のモデルを一覧にする(fork の写しはモデル不明にならない)', () => {
  assert.deepEqual(report().unknownModels.map((m) => [m.agent, m.model, m.tokens]),
    [['codex', 'fugu', 110], ['claude', 'claude-mystery-9', 100]])
})

await check('日付: JST の日付で分け、7 日・先月の範囲を作る', () => {
  const r = report()
  assert.deepEqual([r.days[0], r.days.at(-1), r.days.length], ['2026-10-12', '2026-10-18', 7])
  const alphaIndex = r.projects.findIndex((p) => p.name === 'alpha')
  // 10/17 23:50 JST の m2 は 10/17、10/18 10:00 JST の m1 は 10/18
  near(r.daily[5][alphaIndex].cost, 0.0031 + 0.00456 + 0.0084 + 0.003 + 0.0015, '10/17')
  near(r.daily[6][alphaIndex].cost, 0.044 + 0.0828, '10/18')
  const last = report('lastMonth')
  assert.deepEqual([last.days[0], last.days.at(-1), last.projects.length], ['2026-09-01', '2026-09-30', 0])
  near(last.today.cost, report().today.cost, '先月表示でも今日の額を出す')
})

await check('差分取込み: 追記分だけ読み、書込み途中だった行を数える', async () => {
  const before = fs.statSync(s1).size
  const added = '\n' + JSON.stringify(assistant(9, '2026-10-18T02:40:00Z', alpha, 's1', 'claude-opus-5-5', usage({input: 1000}))) + '\n'
  fs.appendFileSync(s1, added)
  const second = await scan()
  // 前回は書込み途中の行(m4)の手前までしか読んでいない
  assert.equal(second.readBytes, fs.statSync(s1).size - before + Buffer.byteLength(JSON.stringify(m4)))
  near(byName(report()).alpha.claude.cost, 0.1374 + 0.002 + 0.004, 'm4・m9 を追加')
})

await check('末尾に残った record は、更新が止まって 10 分過ぎたら数える', async () => {
  const old = (NOW - 20 * 60_000) / 1000
  fs.utimesSync(x3, old, old)
  await scan()
  near(byName(report()).beta.codex.cost, 6.156 + 0.0015, 'r4 を追加')
  await scan()
  near(byName(report()).beta.codex.cost, 6.156 + 0.0015, '2 回目は数えない')
})

await check('変化がなければ読まず、結果も変わらない', async () => {
  const before = JSON.stringify(report())
  const again = await scan()
  assert.equal(again.readBytes, 0)
  assert.equal(JSON.stringify(report()), before)
})

await check('ファイルが置き換わったら最初から読み直し、前の行は消さない', async () => {
  const replacement = s3 + '.new'
  write(replacement, [assistant(10, '2026-10-15T04:00:00Z', notes, 's3', 'claude-sonnet-5', usage({input: 1000}))])
  fs.renameSync(replacement, s3)
  await scan()
  // m7(読込 1000 × 0.2)は残り、m10(入力 1000 × 2)が増える
  near(byName(report()).sub.claude.cost, 0.0002 + 0.002, 'sub')
})

await check('他の書込みで位置が進んでいたら、その回の取込みは捨てる', () => {
  const record = store.allFiles().get(s3)
  assert.equal(store.commitFile({...record}, record.offset + 1, [], []), false)
})

await check('DB と付属ファイルの権限は 0600', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = dbFile + suffix
    if (fs.existsSync(file)) assert.equal(fs.statSync(file).mode & 0o777, 0o600, file)
  }
})

await check('長い行: 8MB 超は読み捨て、1MB をまたぐ行は 1 行として読む', async () => {
  const longRoot = path.join(work, 'long')
  const file = path.join(longRoot, 'p', 'long.jsonl')
  write(file, [
    {type: 'user', text: 'a'.repeat(9 * 1024 * 1024)},
    assistant(11, '2026-10-18T01:00:00Z', alpha, 'L1', 'claude-opus-5-5', usage({input: 1000}), {pad: 'b'.repeat(1536 * 1024)}),
  ])
  const longStore = new U.UsageStore(path.join(work, 'long.sqlite'))
  const result = await U.scanUsage({roots: {claude: [longRoot], codex: []}, store: longStore, resolve, now: () => NOW})
  assert.equal(result.longLines, 1)
  const r = U.buildReport({store: longStore, period: '7d', now: NOW, home})
  near(r.projects[0].claude.cost, 0.004, 'pad 付きの行')
  longStore.close()
})

await check('壊れた DB は退避して作り直し、新しい版の DB は開かない', () => {
  const broken = path.join(work, 'broken.sqlite')
  fs.writeFileSync(broken, 'not a database'.repeat(1000))
  const fresh = new U.UsageStore(broken)
  fresh.close()
  assert.ok(fs.readdirSync(work).some((name) => name.startsWith('broken.sqlite.broken-')))
  const newer = path.join(work, 'newer.sqlite')
  new U.UsageStore(newer).close()
  execFileSync('/usr/bin/sqlite3', [newer, 'PRAGMA user_version = 99'])
  assert.throws(() => new U.UsageStore(newer), (error) => error.code === 'db_newer')
})

await check('プロジェクト判定: FIFO の .git で止まらず、submodule と外部ボリューム', () => {
  const fifoDir = path.join(home, 'fifo', 'inner')
  fs.mkdirSync(fifoDir, {recursive: true})
  execFileSync('/usr/bin/mkfifo', [path.join(fifoDir, '.git')])
  assert.deepEqual(U.resolveProject(fifoDir, resolve), {root: fifoDir, kind: 'dir'})
  const sub = path.join(alpha, 'vendor', 'sub')
  fs.mkdirSync(sub, {recursive: true})
  fs.writeFileSync(path.join(sub, '.git'), 'gitdir: ../../.git/modules/sub\n')
  assert.deepEqual(U.resolveProject(sub, resolve), {root: sub, kind: 'git'})
  assert.deepEqual(U.resolveProject('/Volumes/Missing/repo', resolve), {root: '/Volumes/Missing/repo', kind: 'dir'})
  assert.deepEqual(U.resolveProject(home, resolve), {root: home, kind: 'dir'})
})

await check('境目のケース: speed は最後の行だけ・record と token_count が取り込みをまたぐ・同じ inode で縮む', async () => {
  const edge = path.join(work, 'edge')
  const claudeEdge = path.join(edge, 'claude')
  const codexEdge = path.join(edge, 'codex')
  const edgeStore = new U.UsageStore(path.join(work, 'edge.sqlite'))
  const edgeScan = () => U.scanUsage({roots: {claude: [claudeEdge], codex: [codexEdge]}, store: edgeStore, resolve, now: () => NOW})
  const edgeCost = () => U.buildReport({store: edgeStore, period: '7d', now: NOW, home}).projects
    .reduce((sum, p) => sum + p.claude.cost + p.codex.cost, 0)
  // Claude: speed / inference_geo は同じ応答の最後の行にだけ書かれる(fast × us = 2.2 倍)
  write(path.join(claudeEdge, 'p', 'f.jsonl'), [
    assistant(20, '2026-10-18T01:00:00Z', alpha, 'F1', 'claude-opus-5-5', usage({input: 1000, out: 10})),
    assistant(20, '2026-10-18T01:00:00Z', alpha, 'F1', 'claude-opus-5-5', usage({input: 1000, out: 500, speed: 'fast', inference_geo: 'us'})),
    // Sonnet 4.5 は 200K 超の単価を確かめられないため料金不明、200K 以下は通常の単価
    assistant(21, '2026-10-18T01:10:00Z', alpha, 'F1', 'claude-sonnet-4-5', usage({input: 250000})),
    assistant(22, '2026-10-18T01:20:00Z', alpha, 'F1', 'claude-sonnet-4-5', usage({input: 1000})),
  ])
  // Codex: 1 回目の取り込みは record で終わり、対応する token_count は次の追記で届く
  const rollout = path.join(codexEdge, 'sessions', 'rollout-e.jsonl')
  write(rollout, [meta('2026-10-18T00:00:00Z', 'E1', alpha), turn('gpt-6.1-sol'), rec('2026-10-18T00:01:00Z', 'e1', u(1000, 0, 100))])
  await edgeScan()
  // (1000×4 + 500×20) × 2.2 + Sonnet 4.5 の 1000×3。record はまだ数えない
  near(edgeCost(), 0.0308 + 0.003, '1 回目')
  fs.appendFileSync(rollout, jsonl([tc('2026-10-18T00:01:00Z', u(1000, 0, 100))]))
  await edgeScan()
  // gpt-6.1-sol: 1000×2 + 100×10。record と token_count で二重に数えない
  near(edgeCost(), 0.0338 + 0.003, '2 回目')
  const unknown = U.buildReport({store: edgeStore, period: '7d', now: NOW, home}).unknownModels
  assert.deepEqual(unknown.map((m) => [m.model, m.tokens]), [['claude-sonnet-4-5', 250000]])

  // 同じ inode のまま縮んだ・先頭が書き換わったファイルは最初から読み直し、行は増やさない
  const total = edgeCost()
  const claudeFile = path.join(claudeEdge, 'p', 'f.jsonl')
  const fd = fs.openSync(claudeFile, 'r+')
  fs.ftruncateSync(fd, 0)
  fs.writeSync(fd, jsonl([assistant(20, '2026-10-18T01:00:00Z', alpha, 'F1', 'claude-opus-5-5', usage({input: 1000, out: 500, speed: 'fast', inference_geo: 'us'}))]))
  fs.closeSync(fd)
  await edgeScan()
  near(edgeCost(), total, '縮んだファイル')
  // 読んだ位置を消して全部読み直しても、合計は変わらない
  execFileSync('/usr/bin/sqlite3', [path.join(work, 'edge.sqlite'), 'DELETE FROM files'])
  await edgeScan()
  near(edgeCost(), total, '全部読み直し')
  edgeStore.close()
})

await check('集計データがないときは DB を作らずに空の結果を返せる', () => {
  const file = path.join(work, 'missing.sqlite')
  const r = U.emptyReport('thisMonth', NOW, file, home)
  assert.deepEqual([r.days[0], r.days.at(-1), r.projects.length, r.lastScanAt], ['2026-10-01', '2026-10-18', 0, null])
  assert.equal(fs.existsSync(file), false)
})

await check('画面: 上位 5 件 + ほか、絞り込みで色を変えない、0 のプロジェクトは描かない', () => {
  const amount = (cost) => ({cost, tokens: cost * 1000, cacheRead: 0, unknownTokens: 0})
  const zero = amount(0)
  const projects = [3, 9, 0, 5, 1, 7, 2, 4].map((cost, i) => ({
    id: `/p${i}`, name: `p${i}`, path: `~/p${i}`, kind: 'git', claude: amount(cost), codex: zero, lastUsedAt: 0,
  }))
  const r = {projects, days: ['2026-10-17', '2026-10-18'], daily: [projects.map((p) => p.claude), projects.map(() => zero)]}
  const opts = {metric: 'cost', withCacheRead: false}
  const series = U.view.buildSeries(r, opts)
  assert.deepEqual(series.map((s) => [s.slot, s.name]),
    [[0, 'p1'], [1, 'p5'], [2, 'p3'], [3, 'p7'], [4, 'p0'], [null, 'ほか 2 件']])
  const all = U.view.stackDays(r, series, opts, null)
  assert.equal(all[0].total, 31)
  assert.deepEqual(all[1].values, [0, 0, 0, 0, 0, 0])
  // 絞り込んでも系列(色の枠)はそのまま、対象以外を 0 にする
  const filtered = U.view.stackDays(r, series, opts, 5)
  assert.deepEqual(filtered[0].values, [0, 7, 0, 0, 0, 0])
  const others = U.view.stackDays(r, series, opts, 6)
  assert.deepEqual(others[0].values, [0, 0, 0, 0, 0, 2])
})

await check('画面: 目盛り・金額とトークンの書式・日付ラベル・背景の明るさ', () => {
  assert.deepEqual(U.view.niceTicks(0), [0])
  assert.deepEqual(U.view.niceTicks(13.2), [0, 5, 10, 15])
  assert.deepEqual(U.view.niceTicks(860000), [0, 250000, 500000, 750000, 1000000])
  assert.equal(U.view.formatValue(1234.5, 'cost'), '$1,234.50')
  assert.equal(U.view.formatValue(1234.5, 'cost', true), '$1.2K')
  assert.equal(U.view.formatValue(0.004, 'cost'), '<$0.01')
  assert.equal(U.view.formatValue(0, 'cost'), '$0')
  assert.equal(U.view.formatValue(3456789, 'tokens'), '3,456,789')
  assert.equal(U.view.formatValue(3456789, 'tokens', true), '3.5M')
  assert.equal(U.view.formatValue(123456789, 'tokens', true), '123M')
  assert.deepEqual(['2026-10-01', '2026-10-05', '2026-10-06'].map((d) => U.view.labelDay(d, 30)), [true, true, false])
  assert.equal(U.view.labelDay('2026-10-06', 7), true)
  assert.equal(U.view.weekday('2026-10-18'), '日')
  assert.equal(U.view.isLightColor('#0f0f11'), false)
  assert.equal(U.view.isLightColor('#fafaf9'), true)
  assert.equal(U.view.relativeTime(NOW - 125 * 60_000, NOW), '2 時間前')
})

await check('DB に会話本文を保存しない', () => {
  store.close()
  const raw = fs.readFileSync(dbFile).toString('utf8') + (fs.existsSync(dbFile + '-wal') ? fs.readFileSync(dbFile + '-wal').toString('utf8') : '')
  assert.ok(!raw.includes('秘密の本文'))
})

if (failures) {
  console.error(`USAGE SMOKE FAILED (${failures})`)
  process.exit(1)
}
console.log('USAGE SMOKE PASS')
