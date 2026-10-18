import {contextBridge, ipcRenderer} from 'electron'
import {CH, type AppearanceSettings, type UsageEvent, type UsagePeriod, type UsageReport} from '../shared/types'

// コスト画面だけに公開する API。ターミナルの入力や設定の変更は渡さない
const api = {
  getReport: (period: UsagePeriod): Promise<UsageReport> => ipcRenderer.invoke(CH.usageReport, period),
  refresh: (): void => ipcRenderer.send(CH.usageRefresh),
  deleteData: (): Promise<boolean> => ipcRenderer.invoke(CH.usageDelete),
  onEvent: (cb: (event: UsageEvent) => void): void => {
    ipcRenderer.on(CH.usageEvent, (_e, event: UsageEvent) => cb(event))
  },
  getSettings: (): Promise<AppearanceSettings> => ipcRenderer.invoke(CH.settingsGet),
  onSettingsUpdate: (cb: (a: AppearanceSettings) => void): void => {
    ipcRenderer.on(CH.settingsUpdate, (_e, a: AppearanceSettings) => cb(a))
  },
}

contextBridge.exposeInMainWorld('claudeTermUsage', api)

export type ClaudeTermUsageApi = typeof api
