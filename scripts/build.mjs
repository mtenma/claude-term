import * as esbuild from 'esbuild'
import {cpSync, readFileSync} from 'node:fs'

// 検査用の版(アプリの更新の通しの検査、scripts/smoke-update-package.mjs)だけに埋め込む設定と出力先。
// 環境変数ではなく引数で渡す(普段の npm start / npm run package に紛れ込まないように)。配る版では null
const args = process.argv.slice(2)
const option = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}
const updateTestFile = option('--update-test')
const out = option('--outdir') ?? 'dist'
// 目印は必ず足す(scripts/release.mjs の bundle が、配る版に紛れ込んだ検査用の版をこれで見つける)
const updateTest = updateTestFile
  ? JSON.stringify({...JSON.parse(readFileSync(updateTestFile, 'utf8')), marker: 'CLAUDE_TERM_UPDATE_TEST_BUILD'})
  : 'null'
if (updateTestFile) console.warn(`[build] 検査用の更新の設定を埋め込みます(${updateTestFile})。この版は配らないでください`)

const common = {
  bundle: true,
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
}

// xterm DOM レンダラーの WidthCache._measure は offsetWidth(整数丸め)で文字幅を
// 測るが、セル幅の計算元 CharSizeService は measureText(小数精度)で測る。
// この精度差(Menlo 13px で約 0.014px/文字)が letter-spacing 補正に混入し、
// 130 列超の行で約 2px 右へドリフトして右端の文字が欠ける。
// offsetWidth を getBoundingClientRect().width に置き換えて両者の精度を揃える。
// (xterm 更新でパッチ対象が見つからなくなったらビルドを失敗させて気付けるようにする)
const patchXtermWidthCache = {
  name: 'patch-xterm-width-cache',
  setup(build) {
    build.onLoad({filter: /@xterm[/\\]xterm[/\\]lib[/\\]xterm\.m?js$/}, (args) => {
      const src = readFileSync(args.path, 'utf8')
      const pattern = /textContent=([$\w]+)\.repeat\(32\),([$\w]+)\.offsetWidth\/32\}/
      if (!pattern.test(src)) {
        throw new Error('xterm WidthCache._measure のパッチ対象が見つかりません(xterm 更新時は scripts/build.mjs を要確認)')
      }
      return {
        contents: src.replace(pattern, 'textContent=$1.repeat(32),$2.getBoundingClientRect().width/32}'),
        loader: 'js',
      }
    })
  },
}

await Promise.all([
  esbuild.build({
    ...common,
    entryPoints: ['src/main/main.ts'],
    outfile: `${out}/main/main.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'node-pty'],
    define: {__CLAUDE_TERM_UPDATE_TEST__: updateTest},
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/main/codexHookRelay.ts'],
    outfile: `${out}/main/codexHookRelay.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  }),
  // コスト画面の集計(utilityProcess で動かす。node:sqlite は Electron 内蔵のものを使う)
  esbuild.build({
    ...common,
    entryPoints: ['src/main/usageService.ts'],
    outfile: `${out}/main/usageService.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: `${out}/preload/preload.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload/usagePreload.ts'],
    outfile: `${out}/preload/usagePreload.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload/updatePreload.ts'],
    outfile: `${out}/preload/updatePreload.js`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/renderer/update.ts'],
    outfile: `${out}/renderer/update.js`,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/renderer/cost.ts'],
    outfile: `${out}/renderer/cost.js`,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/renderer/renderer.ts'],
    outfile: `${out}/renderer/renderer.js`,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    plugins: [patchXtermWidthCache],
  }),
])

for (const page of ['index.html', 'cost.html', 'update.html']) cpSync(`src/renderer/${page}`, `${out}/renderer/${page}`)
