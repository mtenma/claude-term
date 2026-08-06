import * as esbuild from 'esbuild'
import {cpSync} from 'node:fs'

const common = {
  bundle: true,
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
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
  }),
])

cpSync('src/renderer/index.html', 'dist/renderer/index.html')
