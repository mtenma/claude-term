import {app, type BrowserWindow} from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {CH, DEFAULT_APPEARANCE} from '../shared/types'
import {openCostWindow} from './usageWindow'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const NOW = '2026-10-18T03:00:00Z' // 10/18 12:00 JST
const XSS_NAME = '<img src=x onerror="document.title=1">'

/** 検証用の偽データの置き場所。開発実行ではプロジェクト内の dist-test を使う */
function fixtureRoot(): string {
  const base = process.env.CLAUDE_TERM_USAGE_FIXTURE_DIR ??
    (app.isPackaged ? app.getPath('temp') : path.join(app.getAppPath(), 'dist-test'))
  return path.join(base, `usage-shot-${process.pid}`)
}

const writeLines = (file: string, lines: object[]) => {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n')
}

/** 8 プロジェクト × 7 日分の偽の記録(上位 5 + ほか 3、料金不明、名前に HTML を含むフォルダ) */
function writeFixture(root: string): void {
  const projects = ['alpha', 'beta', '宮古島 資料', XSS_NAME, 'gamma', 'delta', 'epsilon']
    .map((name) => path.join(root, 'home', name))
  for (const dir of projects) fs.mkdirSync(path.join(dir, '.git'), {recursive: true})
  // offset 日前の JST の hour 時(NOW の 12 時より前に収める)
  const day = (offset: number, hour: number) =>
    new Date(Date.parse('2026-10-18T00:00:00+09:00') - offset * 86_400_000 + hour * 3_600_000).toISOString()
  let id = 0
  projects.forEach((cwd, p) => {
    const lines: object[] = []
    for (let d = 0; d < 7; d++) {
      if ((p + d) % 4 === 3) continue // 利用のない日も作る
      const scale = (7 - p) * (1 + ((d * 3 + p) % 5))
      lines.push({
        type: 'assistant', sessionId: `s${p}`, cwd, timestamp: day(d, 1 + p), requestId: `r${++id}`,
        message: {
          id: `m${id}`, model: p % 2 ? 'claude-sonnet-5-5' : 'claude-opus-5-5',
          usage: {
            input_tokens: 2000 * scale, output_tokens: 1500 * scale, cache_read_input_tokens: 60000 * scale,
            cache_creation_input_tokens: 4000 * scale,
            cache_creation: {ephemeral_5m_input_tokens: 4000 * scale, ephemeral_1h_input_tokens: 0},
          },
        },
      })
    }
    writeLines(path.join(root, 'claude', 'projects', `p${p}`, `s${p}.jsonl`), lines)
  })
  const usage = (input: number, output: number) => ({
    input_tokens: input, cached_input_tokens: Math.floor(input / 2), cache_write_input_tokens: 0,
    output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output,
  })
  writeLines(path.join(root, 'codex', 'sessions', '2026', '10', '18', 'rollout-a.jsonl'), [
    {type: 'session_meta', timestamp: day(1, 9), payload: {id: 'x1', cwd: projects[1]}},
    {type: 'turn_context', timestamp: day(1, 9), payload: {model: 'gpt-6-astra'}},
    {type: 'event_msg', timestamp: day(1, 9), payload: {type: 'token_count', info: {total_token_usage: usage(400000, 20000), last_token_usage: usage(400000, 20000)}}},
  ])
  writeLines(path.join(root, 'codex', 'sessions', '2026', '10', '18', 'rollout-b.jsonl'), [
    {type: 'session_meta', timestamp: day(0, 8), payload: {id: 'x2', cwd: '/private/tmp/claude-term-shot'}},
    {type: 'turn_context', timestamp: day(0, 8), payload: {model: 'fugu'}},
    {type: 'event_msg', timestamp: day(0, 8), payload: {type: 'token_count', info: {total_token_usage: usage(90000, 5000), last_token_usage: usage(90000, 5000)}}},
  ])
}

type Variant = 'cost' | 'cost-light' | 'cost-empty' | 'cost-live'

async function waitFor(win: BrowserWindow, expression: string, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await win.webContents.executeJavaScript(expression)) return
    await delay(200)
  }
  throw new Error(`cost window: ${label} did not happen`)
}

/**
 * コスト画面を偽データで開き、表示と操作を検証する。開いた窓は onOpen で撮影対象として知らせる。
 * 記録・DB・現在時刻は環境変数で差し替え、実ユーザーの集計データには触れない
 */
export async function checkCostWindow(variant: Variant, onOpen: (win: BrowserWindow) => void): Promise<void> {
  if (variant === 'cost-live') {
    // 実際の記録で見た目を確かめる。普段の集計データに書かないよう、DB の場所の指定を必須にする
    if (!process.env.CLAUDE_TERM_USAGE_DB) throw new Error('cost-live requires CLAUDE_TERM_USAGE_DB')
  } else {
    const root = fixtureRoot()
    fs.rmSync(root, {recursive: true, force: true})
    fs.mkdirSync(root, {recursive: true})
    process.once('exit', () => fs.rmSync(root, {recursive: true, force: true}))
    if (variant !== 'cost-empty') writeFixture(root)
    process.env.CLAUDE_TERM_USAGE_CLAUDE_DIR = path.join(root, 'claude', 'projects')
    process.env.CLAUDE_TERM_USAGE_CODEX_DIR = path.join(root, 'codex')
    process.env.CLAUDE_TERM_USAGE_DB = path.join(root, 'usage.sqlite')
    process.env.CLAUDE_TERM_USAGE_NOW = NOW
  }

  const win = openCostWindow()
  // 検証に失敗した場合も、その時点のコスト画面を撮れるように先に知らせる
  onOpen(win)
  // CLAUDE_TERM_WINSIZE はコスト画面の大きさにも使う(最小幅でのはみ出しの確認)
  const size = /^(\d+)x(\d+)$/.exec(process.env.CLAUDE_TERM_WINSIZE ?? '')
  if (size) win.setSize(Number(size[1]), Number(size[2]))
  await new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  await waitFor(win, `document.body.dataset.state === 'ready' &&
    document.getElementById('updated').textContent.includes('最終更新')`, 'import', 60_000)

  // プロジェクト表の枠が縮められて行が隠れていないこと(行が DOM にあるだけでは見えているとは限らない)
  const clipped = await win.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('.table-scroll')
    return box.scrollHeight - box.clientHeight
  })()`) as number
  if (clipped > 1) throw new Error(`cost window: project table is clipped by ${clipped}px`)

  if (variant === 'cost-live') {
    const overflow = await win.webContents.executeJavaScript(
      `document.querySelector('.content').scrollWidth - document.querySelector('.content').clientWidth`) as number
    if (overflow > 0) throw new Error(`cost-live: horizontal overflow ${overflow}`)
    return
  }

  if (variant === 'cost-empty') {
    const empty = await win.webContents.executeJavaScript(`document.getElementById('empty').textContent`) as string
    if (!empty.includes('見つかりませんでした')) throw new Error(`cost-empty: unexpected message "${empty}"`)
    return
  }

  const dom = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    rows: document.querySelectorAll('#projects tbody tr').length,
    bars: document.querySelectorAll('#chart .hit').length,
    legend: [...document.querySelectorAll('#legend li')].map((li) => li.textContent),
    unknown: document.getElementById('unknown-value').textContent,
    images: document.querySelectorAll('img').length,
    names: [...document.querySelectorAll('.project-name')].map((n) => n.textContent),
    title: document.title,
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    contentOverflow: document.querySelector('.content').scrollWidth - document.querySelector('.content').clientWidth,
  })`)) as {rows: number; bars: number; legend: string[]; unknown: string; images: number; names: string[];
    title: string; overflow: number; contentOverflow: number}
  const problems: string[] = []
  if (dom.rows !== 8) problems.push(`rows=${dom.rows}`)
  if (dom.bars !== 7) problems.push(`bars=${dom.bars}`)
  // 一時フォルダは料金不明のモデルだけなので、額の系列には入らない(7 件 → 上位 5 + ほか 2)
  if (dom.legend.length !== 6 || dom.legend.at(-1) !== 'ほか 2 件') problems.push(`legend=${JSON.stringify(dom.legend)}`)
  if (!dom.unknown.includes('トークン')) problems.push(`unknown=${dom.unknown}`)
  // フォルダ名の HTML は文字のまま表示され、要素として解釈されない
  if (dom.images !== 0 || !dom.names.includes(XSS_NAME) || dom.title === '1') problems.push('folder name was interpreted as HTML')
  if (dom.overflow > 0 || dom.contentOverflow > 0) problems.push(`horizontal overflow ${dom.overflow}/${dom.contentOverflow}`)
  // 表の各行の額の和が期間合計と合う(表示の丸めの分だけ許す)
  const sums = JSON.parse(await win.webContents.executeJavaScript(`JSON.stringify({
    total: document.getElementById('total-value').title,
    rows: [...document.querySelectorAll('#projects tbody tr')].map((tr) => tr.children[1].firstChild.textContent),
  })`)) as {total: string; rows: string[]}
  const money = (text: string) => Number(text.replace(/[$,]/g, '').replace('<0.01', '0'))
  const rowSum = sums.rows.reduce((sum, text) => sum + money(text), 0)
  if (Math.abs(rowSum - money(sums.total)) > 0.01 * sums.rows.length) problems.push(`rows ${rowSum} != total ${sums.total}`)

  // キーボードだけで絞り込みとツールチップを操作できる
  win.focus()
  await win.webContents.executeJavaScript(`document.querySelector('.project-button').focus()`)
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Space'})
  win.webContents.sendInputEvent({type: 'keyUp', keyCode: 'Space'})
  await delay(300)
  const filtered = await win.webContents.executeJavaScript(`
    !document.getElementById('filter').hidden &&
    document.querySelector('.project-button').getAttribute('aria-pressed') === 'true' &&
    document.activeElement === document.querySelector('.project-button')`)
  // 表は作り直されるので、押したボタンに焦点が戻っていること(Tab で先頭からやり直しにならない)
  if (!filtered) problems.push('keyboard filter did not apply or focus was lost')
  // hidden 属性だけでなく、実際に表示から消えていることを確かめる
  const shown = (id: string) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`
  const leftovers = await win.webContents.executeJavaScript(`(() => {
    document.getElementById('filter-clear').click()
    return [${shown('filter')} && 'filter', ${shown('cache-read-option')} && 'cache-read-option'].filter(Boolean)
  })()`) as string[]
  if (leftovers.length) problems.push(`still displayed: ${leftovers.join(', ')}`)
  await win.webContents.executeJavaScript(`document.getElementById('chart').focus()`)
  win.webContents.sendInputEvent({type: 'keyDown', keyCode: 'Right'})
  await delay(300)
  const tooltip = await win.webContents.executeJavaScript(`
    !document.getElementById('tooltip').hidden && document.querySelector('#tooltip .tip-head').textContent`)
  if (!tooltip) problems.push('keyboard tooltip did not open')

  if (variant === 'cost-light') {
    win.webContents.send(CH.settingsUpdate, {...DEFAULT_APPEARANCE, background: '#fafaf9', foreground: '#1c1917'})
    await win.webContents.executeJavaScript(`document.querySelector('input[value="30d"]').click()`)
    await win.webContents.executeJavaScript(`document.querySelector('input[value="tokens"]').click()`)
    await waitFor(win, `document.querySelectorAll('#chart .hit').length === 30`, '30-day chart')
    const theme = await win.webContents.executeJavaScript(`document.documentElement.dataset.theme`)
    if (theme !== 'light') problems.push(`theme=${theme}`)
    // 期間を変えたら、前の期間の内訳(ツールチップ)を残さない
    if (await win.webContents.executeJavaScript(shown('tooltip'))) problems.push('stale tooltip after period change')
  }
  if (problems.length) throw new Error(`cost window: ${problems.join(', ')}`)
  // 焦点の移動でスクロールした位置を戻し、合計欄から撮る
  await win.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 0`)
}
