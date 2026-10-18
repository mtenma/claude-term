export type SessionState = 'running' | 'attention' | 'idle' | 'unknown' | 'exited'
export type AgentKind = 'claude' | 'codex'

export const AGENT_LABELS: Record<AgentKind, string> = {claude: 'Claude Code', codex: 'Codex'}

export interface SessionMetrics {
  model?: string
  contextPct?: number
  costUsd?: number
  totalTokens?: number
  rateLimits?: {remainingPct: number; windowMinutes: number}[]
}

export interface SessionInfo {
  id: string
  title: string
  /** ツールチップ用の表示(ターミナル番号 + ~ 略記の作業ディレクトリ) */
  cwd: string
  state: SessionState
  preview: string[]
  /** Claude の statusLine / Codex hooks で得た情報(未取得なら null) */
  metrics: SessionMetrics | null
  /** 承認待ちのとき、何の承認を求めているかのメッセージ(不明なら null) */
  attentionMessage: string | null
  /** hooks で検知したエージェント。通知とツール固有の改行入力に使う */
  activeAgent: AgentKind | null
}

export interface SessionsUpdate {
  sessions: SessionInfo[]
  activeId: string | null
}

// 同じセッションへの再接続も区別し、前の表示に対する ACK を持ち込まない。
export interface TermAck {
  id: string
  epoch: number
  bytes: number
}

export interface TermInput {
  id: string
  data: string
}

export type TermOut = {epoch: number} & (
  | {kind: 'snapshot'; id: string; data: string; cols: number; rows: number}
  | {kind: 'resize'; id: string; cols: number; rows: number; reflowCursorLine: boolean}
  | {kind: 'data'; id: string; data: string}
)

export interface AppearanceSettings {
  /** 背景の不透明度(%) 20-100。100 未満でウィンドウ背景が透過する */
  opacity: number
  background: string
  foreground: string
  accent: string
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  opacity: 100,
  background: '#0f0f11',
  foreground: '#e4e4e7',
  accent: '#d97757',
}

// ---- コスト画面 ----

export type UsagePeriod = '7d' | '30d' | 'thisMonth' | 'lastMonth'
export const USAGE_PERIODS: readonly UsagePeriod[] = ['7d', '30d', 'thisMonth', 'lastMonth']

export interface UsageAmount {
  /** API 換算額(USD)。料金表にあるモデルの分だけを含む */
  cost: number
  /** 入力 + キャッシュ書込 + 出力。キャッシュ読込は大半を占めるため含めない */
  tokens: number
  cacheRead: number
  /** 料金表にないモデルのトークン(tokens と同じ数え方) */
  unknownTokens: number
}

export interface UsageProject {
  /** プロジェクトの根のパス。一時フォルダは 'temp' */
  id: string
  name: string
  /** ~ 略記のパス(一時フォルダは空) */
  path: string
  /** unknown は作業フォルダの記録がないセッション */
  kind: 'git' | 'dir' | 'temp' | 'unknown'
  claude: UsageAmount
  codex: UsageAmount
  lastUsedAt: number
}

export interface UsageReport {
  period: UsagePeriod
  /** 現地日付 YYYY-MM-DD(古い順) */
  days: string[]
  projects: UsageProject[]
  /** daily[日の添字][プロジェクトの添字] */
  daily: UsageAmount[][]
  today: UsageAmount
  unknownModels: {agent: AgentKind; model: string; tokens: number}[]
  /** 集計データ内で最も古い記録の時刻(エージェント別) */
  earliest: Record<AgentKind, number | null>
  lastScanAt: number | null
  generatedAt: number
  pricingCheckedAt: string
  /** 集計データの保存場所(~ 略記) */
  storagePath: string
}

export type UsageErrorCode = 'db_newer' | 'db_failed' | 'service_exited' | 'timeout' | 'internal'
export const USAGE_ERROR_CODES: readonly UsageErrorCode[] = ['db_newer', 'db_failed', 'service_exited', 'timeout', 'internal']

/** 画面へ返す取得結果。失敗は種類だけを返し、文面は画面側で出し分ける */
export type UsageReportResult = {report: UsageReport} | {error: UsageErrorCode}

export type UsageEvent =
  | {kind: 'progress'; doneBytes: number; totalBytes: number; firstImport: boolean}
  | {kind: 'scanned'; at: number; parseErrors: number; longLines: number; unreadable: number}
  | {kind: 'error'; code: UsageErrorCode}
  | {kind: 'deleted'}

// IPC チャンネル名。main / preload / renderer で共有する契約
export const CH = {
  sessionCreate: 'session:create',
  sessionKill: 'session:kill',
  sessionAttach: 'session:attach',
  sessionsRequest: 'sessions:request',
  sessionsReorder: 'sessions:reorder',
  sessionsUpdate: 'sessions:update',
  editSelectAll: 'edit:selectAll',
  editFind: 'edit:find',
  editOpenSettings: 'edit:openSettings',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  settingsUpdate: 'settings:update',
  shellOpenExternal: 'shell:openExternal',
  termOut: 'term:out',
  termIn: 'term:in',
  termResize: 'term:resize',
  termAck: 'term:ack',
  usageReport: 'usage:report',
  usageRefresh: 'usage:refresh',
  usageDelete: 'usage:delete',
  usageEvent: 'usage:event',
} as const
