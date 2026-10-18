import type {AgentKind} from '../shared/types'

/** 料金表を公式ページで確かめた日。画面の注記にも出す */
export const PRICING_CHECKED_AT = '2026-10-18'

/** $ / 1M トークン。Codex は書込の区別がないため cacheWrite5m だけを使う */
export interface Rates {
  input: number
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
}

/** Claude の Web 検索は 1,000 回あたり $10 */
export const WEB_SEARCH_USD = 0.01

/**
 * OpenAI の長文脈の単価に切り替わる 1 回の入力(キャッシュ分を含む)。
 * 公式ページに判定単位の記載がないため、1 回ごとの入力で判定する前提とする
 */
export const CODEX_LONG_CONTEXT_TOKENS = 272_000

interface ClaudeRates extends Rates {
  /** fast mode の倍率(対応モデルのみ) */
  fast?: number
  /** inference_geo: "us" の 1.1 倍が掛かるか(4.6 以降) */
  usGeo: boolean
}

const claude = (input: number, cacheRead: number, output: number, usGeo: boolean, fast?: number): ClaudeRates => ({
  input,
  cacheWrite5m: input * 1.25,
  cacheWrite1h: input * 2,
  cacheRead,
  output,
  usGeo,
  fast,
})

// 出典: https://platform.claude.com/docs/en/about-claude/pricing (Model pricing / Fast mode / Data residency)
// 長文脈の割増は 4.6 以降(Haiku 5.5 を除く)にはない。Haiku 5.5 は入力 100K で単価が変わるため載せていない
const CLAUDE: Record<string, ClaudeRates> = {
  'claude-fable-5-1': claude(10, 0.25, 50, true),
  'claude-fable-5': claude(10, 1, 50, true),
  'claude-opus-5-5': claude(4, 0.2, 20, true, 2),
  'claude-opus-5': claude(5, 0.5, 25, true, 2),
  'claude-opus-4-8': claude(5, 0.5, 25, true, 2),
  'claude-opus-4-7': claude(5, 0.5, 25, true),
  'claude-opus-4-6': claude(5, 0.5, 25, true),
  'claude-opus-4-5': claude(5, 0.5, 25, false),
  'claude-opus-4-1': claude(15, 1.5, 75, false),
  'claude-opus-4': claude(15, 1.5, 75, false),
  'claude-sonnet-5-5': claude(2, 0.1, 10, true),
  'claude-sonnet-5': claude(2, 0.2, 10, true),
  'claude-sonnet-4-6': claude(3, 0.3, 15, true),
  'claude-sonnet-4-5': claude(3, 0.3, 15, false),
  'claude-sonnet-4': claude(3, 0.3, 15, false),
  'claude-haiku-4-5': claude(1, 0.1, 5, false),
}

const openai = (input: number, cacheRead: number, cacheWrite: number, output: number): Rates => ({
  input,
  cacheWrite5m: cacheWrite,
  cacheWrite1h: cacheWrite,
  cacheRead,
  output,
})

// 出典: https://developers.openai.com/api/docs/pricing (Standard の Short context / Long context)
// GPT-5.6 Sol は 2026-11-21 までの期間限定価格。単価の改定履歴は持たず、現在の単価で計算する
const OPENAI: Record<string, {standard: Rates; long: Rates}> = {
  'gpt-6-astra': {standard: openai(10, 1, 12.5, 50), long: openai(20, 2, 25, 75)},
  'gpt-6.1-sol': {standard: openai(2, 0.1, 2.5, 10), long: openai(4, 0.2, 5, 15)},
  'gpt-6-sol': {standard: openai(2, 0.2, 2.5, 10), long: openai(4, 0.4, 5, 15)},
  'gpt-5.6-sol': {standard: openai(4, 0.4, 5, 20), long: openai(8, 0.8, 10, 30)},
  'gpt-5.6-terra': {standard: openai(2, 0.2, 2.5, 12), long: openai(4, 0.4, 5, 18)},
  'gpt-5.6-luna': {standard: openai(0.2, 0.02, 0.25, 1.2), long: openai(0.4, 0.04, 0.5, 1.8)},
}

const scale = (rates: Rates, factor: number): Rates => ({
  input: rates.input * factor,
  cacheWrite5m: rates.cacheWrite5m * factor,
  cacheWrite1h: rates.cacheWrite1h * factor,
  cacheRead: rates.cacheRead * factor,
  output: rates.output * factor,
})

/**
 * 1 回分の呼出しに当てる単価。料金表にないモデルは null(料金不明)。
 * モデル名は末尾の日付を外して完全一致で引く(前方一致だと claude-opus-5-5 が opus-5 に当たる)
 */
export function ratesFor(agent: AgentKind, model: string, speed: string, geo: string, longContext: boolean): Rates | null {
  if (agent === 'codex') {
    const entry = OPENAI[model]
    return entry ? (longContext ? entry.long : entry.standard) : null
  }
  const entry = CLAUDE[model.replace(/-\d{8}$/, '')]
  if (!entry) return null
  let factor = 1
  if (speed === 'fast') {
    if (!entry.fast) return null
    factor *= entry.fast
  }
  // 両方が掛かる場合は掛け合わせる(公式ページの記載どおり)
  if (geo === 'us' && entry.usGeo) factor *= 1.1
  return factor === 1 ? entry : scale(entry, factor)
}
