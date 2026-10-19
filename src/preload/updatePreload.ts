import {contextBridge, ipcRenderer} from 'electron'
import {CH, type AppearanceSettings, type UpdateView} from '../shared/types'

// お知らせの窓だけに公開する API。引数は渡さない(確かめ済みの更新情報は main だけが持つ)
const api = {
  getView: (): Promise<UpdateView | null> => ipcRenderer.invoke(CH.updateGet),
  onView: (cb: (view: UpdateView) => void): void => {
    ipcRenderer.on(CH.updateView, (_e, view: UpdateView) => cb(view))
  },
  start: (): void => ipcRenderer.send(CH.updateStart),
  cancel: (): void => ipcRenderer.send(CH.updateCancel),
  later: (): void => ipcRenderer.send(CH.updateLater),
  openReleases: (): void => ipcRenderer.send(CH.updateOpenReleases),
  getSettings: (): Promise<AppearanceSettings> => ipcRenderer.invoke(CH.settingsGet),
  onSettingsUpdate: (cb: (a: AppearanceSettings) => void): void => {
    ipcRenderer.on(CH.settingsUpdate, (_e, a: AppearanceSettings) => cb(a))
  },
}

contextBridge.exposeInMainWorld('claudeTermUpdate', api)

export type ClaudeTermUpdateApi = typeof api
