import {contextBridge, ipcRenderer} from 'electron'
import {CH, type SessionInfo, type SessionsUpdate, type TermOut} from '../shared/types'

const api = {
  createSession: (): Promise<SessionInfo> => ipcRenderer.invoke(CH.sessionCreate),
  killSession: (id: string): Promise<void> => ipcRenderer.invoke(CH.sessionKill, id),
  attachSession: (id: string): void => ipcRenderer.send(CH.sessionAttach, id),
  requestSessions: (): Promise<SessionsUpdate> => ipcRenderer.invoke(CH.sessionsRequest),
  reorderSessions: (ids: string[]): void => ipcRenderer.send(CH.sessionsReorder, ids),
  termInput: (data: string): void => ipcRenderer.send(CH.termIn, data),
  termResize: (cols: number, rows: number): void => ipcRenderer.send(CH.termResize, {cols, rows}),
  termAck: (bytes: number): void => ipcRenderer.send(CH.termAck, bytes),
  onSessionsUpdate: (cb: (u: SessionsUpdate) => void): void => {
    ipcRenderer.on(CH.sessionsUpdate, (_e, u: SessionsUpdate) => cb(u))
  },
  onTermOut: (cb: (p: TermOut) => void): void => {
    ipcRenderer.on(CH.termOut, (_e, p: TermOut) => cb(p))
  },
}

contextBridge.exposeInMainWorld('claudeTerm', api)

export type ClaudeTermApi = typeof api
