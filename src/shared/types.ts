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

export type TermOut =
  | {kind: 'snapshot'; id: string; data: string; cols: number; rows: number}
  | {kind: 'resize'; id: string; cols: number; rows: number; reflowCursorLine: boolean}
  | {kind: 'data'; id: string; data: string}

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
} as const
