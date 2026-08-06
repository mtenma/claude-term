export type SessionState = 'running' | 'attention' | 'idle' | 'exited'

export interface SessionInfo {
  id: string
  title: string
  state: SessionState
  preview: string[]
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
  sessionsUpdate: 'sessions:update',
  termOut: 'term:out',
  termIn: 'term:in',
  termResize: 'term:resize',
  termAck: 'term:ack',
} as const
