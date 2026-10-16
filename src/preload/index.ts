import { contextBridge, ipcRenderer } from 'electron'
import { APP_INFO_CHANNEL, type HantongApi } from '../shared/ipc'

if (!process.contextIsolated) throw new Error('Context isolation is required')

// Expose operations rather than a generic channel sender or Electron objects.
const api: HantongApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL)
})

if (process.isMainFrame) contextBridge.exposeInMainWorld('api', api)
