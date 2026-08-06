// SessionManager の GUI 非依存スモークテスト。
// 「renderer が受け取るストリーム(snapshot + data)から再構築した画面」が
// 「main プロセスのミラー(headless)の画面」と完全一致することを検証する。
// センチネル handoff の欠落・重複・順序バグはここで機械的に検出できる。
import * as esbuild from 'esbuild'
import {createRequire} from 'node:module'
import * as path from 'node:path'
import {fileURLToPath} from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.chdir(root)

await esbuild.build({
  entryPoints: ['src/main/sessions.ts'],
  outfile: 'dist-test/sessions.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['node-pty'],
  logLevel: 'silent',
})

const {SessionManager} = require(path.join(root, 'dist-test/sessions.cjs'))
const {Terminal} = require('@xterm/headless')
const {SerializeAddon} = require('@xterm/addon-serialize')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const watchdog = setTimeout(() => {
  console.error('SMOKE TIMEOUT (センチネル callback が発火していない可能性)')
  process.exit(1)
}, 30000)

let pass = true
const check = (cond, label) => {
  if (cond) console.log(`ok   ${label}`)
  else {
    pass = false
    console.error(`FAIL ${label}`)
  }
}

const sm = new SessionManager(0)
const received = []
sm.onTermOut = (p) => received.push(p)

const a = sm.create()
const b = sm.create()
await sleep(1500) // シェル起動待ち

sm.writeTo(a.id, "printf '\\033[31mRED\\033[0m あか漢字\\n'; seq 1 120\r")
sm.writeTo(b.id, 'seq 500 700\r')
await sleep(120)
sm.attach(a.id) // 出力が流れている最中に attach(競合の再現)
await sleep(100)
sm.writeTo(a.id, 'seq 200 260\r')
await sleep(800)
sm.attach(b.id)
await sleep(150)
sm.attach(a.id) // 往復切替
await sleep(1500) // 静穏化待ち

const snapshots = received.filter((p) => p.kind === 'snapshot')
check(snapshots.length === 3, `snapshot が attach 回数分届く (got ${snapshots.length})`)

let currentId = null
let orderOk = received.length > 0
for (const p of received) {
  if (p.kind === 'snapshot') currentId = p.id
  else if (currentId === null || p.id !== currentId) orderOk = false
}
check(orderOk, 'data は直前の snapshot と同一セッションのものだけが届く')

const lastSnapshotIndex = received.map((p) => p.kind).lastIndexOf('snapshot')
check(received[lastSnapshotIndex]?.id === a.id, '最後の snapshot が最終 attach 先のもの')

// renderer と同じ手順で再構築: 最後の snapshot を書き、以後の data を順に書く
const ref = new Terminal({cols: 80, rows: 24, scrollback: 3000, allowProposedApi: true})
const refSer = new SerializeAddon()
ref.loadAddon(refSer)
for (let i = lastSnapshotIndex; i >= 0 && i < received.length; i++) {
  ref.write(received[i].data)
}
await new Promise((r) => ref.write('', r))
const rebuilt = refSer.serialize({scrollback: 2000})
const mirror = sm.serializeSession(a.id)
check(
  rebuilt === mirror,
  `再構築画面がミラー画面と一致 (rebuilt=${rebuilt.length} mirror=${mirror?.length} chars)`,
)

// リサイズ起因の再描画出力で「待機」が「実行中」に化けないこと
await sleep(3000) // 完全に静穏化させる
const stateBefore = sm.currentUpdate().sessions.find((x) => x.id === b.id)?.state
sm.resize(100, 30) // SIGWINCH → シェルがプロンプトを再描画する
await sleep(1300)
const stateAfter = sm.currentUpdate().sessions.find((x) => x.id === b.id)?.state
check(
  stateBefore === 'idle' && stateAfter === 'idle',
  `リサイズ後も待機セッションは待機のまま (before=${stateBefore} after=${stateAfter})`,
)

sm.disposeAll()
clearTimeout(watchdog)
console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL')
process.exit(pass ? 0 : 1)
