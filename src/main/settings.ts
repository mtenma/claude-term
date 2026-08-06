import {app} from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {DEFAULT_APPEARANCE, type AppearanceSettings} from '../shared/types'

// 外観設定の永続化(userData/settings.json)。
// hooks の同意記録(config.json)とはファイルを分け、書き込み競合を避ける

const COLOR_RE = /^#[0-9a-fA-F]{6}$/

let current: AppearanceSettings | null = null
let saveTimer: NodeJS.Timeout | null = null

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

/** renderer 由来の値を信頼せず、既知のキーだけを検証して取り込む */
export function normalizeAppearance(raw: unknown): AppearanceSettings {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const out = {...DEFAULT_APPEARANCE}
  if (typeof src.opacity === 'number' && Number.isFinite(src.opacity)) {
    out.opacity = Math.min(100, Math.max(20, Math.round(src.opacity)))
  }
  for (const key of ['background', 'foreground', 'accent'] as const) {
    const v = src[key]
    if (typeof v === 'string' && COLOR_RE.test(v)) out[key] = v
  }
  return out
}

export function getAppearance(): AppearanceSettings {
  if (current) return current
  let stored: unknown
  try {
    stored = (JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as {appearance?: unknown})
      .appearance
  } catch {
    // 未作成・破損時はデフォルト
  }
  let a = normalizeAppearance(stored)
  // 検証用の一時上書き(devshot などから使う。それ自体は保存しない)
  if (process.env.CLAUDE_TERM_APPEARANCE) {
    try {
      a = normalizeAppearance({...a, ...(JSON.parse(process.env.CLAUDE_TERM_APPEARANCE) as object)})
    } catch {
      // 不正な JSON は無視
    }
  }
  current = a
  return a
}

/** 検証済みの値を返しつつ、連続変更(スライダー操作等)をまとめて保存する */
export function setAppearance(raw: unknown): AppearanceSettings {
  const a = normalizeAppearance(raw)
  current = a
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      fs.mkdirSync(path.dirname(settingsPath()), {recursive: true})
      fs.writeFileSync(settingsPath(), `${JSON.stringify({appearance: current}, null, 2)}\n`)
    } catch (err) {
      console.warn('[settings] 保存に失敗:', err)
    }
  }, 300)
  return a
}
