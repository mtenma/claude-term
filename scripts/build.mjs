import * as esbuild from 'esbuild'
import {cpSync, readFileSync} from 'node:fs'

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
    outfile: 'dist/main/main.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron', 'node-pty'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/main/codexHookRelay.ts'],
    outfile: 'dist/main/codexHookRelay.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/preload/preload.ts'],
    outfile: 'dist/preload/preload.js',
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  esbuild.build({
    ...common,
    entryPoints: ['src/renderer/renderer.ts'],
    outfile: 'dist/renderer/renderer.js',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    plugins: [patchXtermWidthCache],
  }),
])

cpSync('src/renderer/index.html', 'dist/renderer/index.html')
