export type SessionState = 'running' | 'attention' | 'idle' | 'exited'

export interface SessionInfo {
  id: string
  title: string
  /** ツールチップ用の表示(ターミナル番号 + ~ 略記の作業ディレクトリ) */
  cwd: string
  state: SessionState
  preview: string[]
  /** statusLine 連携で得た Claude Code セッションの情報(未取得なら null) */
  metrics: {model?: string; contextPct?: number; costUsd?: number} | null
  /** 承認待ちのとき、何の承認を求めているかのメッセージ(不明なら null) */
  attentionMessage: string | null
  /** hooks 検知により claude が動いているセッションか(改行支援のゲートに使う) */
  claudeActive: boolean
}

export interface SessionsUpdate {
  sessions: SessionInfo[]
  activeId: string | null
}

export type TermOut =
  | {kind: 'snapshot'; id: string; data: string}
  | {kind: 'data'; id: string; data: string}

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
  shellOpenExternal: 'shell:openExternal',
  termOut: 'term:out',
  termIn: 'term:in',
  termResize: 'term:resize',
  termAck: 'term:ack',
} as const
