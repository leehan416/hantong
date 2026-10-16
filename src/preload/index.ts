import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  type AccountViewStatus,
  type HantongApi
} from '../shared/ipc'

if (!process.contextIsolated) throw new Error('Context isolation is required')

// Expose operations rather than a generic channel sender or Electron objects.
const api: HantongApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  getAccounts: () => ipcRenderer.invoke(ACCOUNT_STATE_CHANNEL),
  addAccount: () => ipcRenderer.invoke(ACCOUNT_ADD_CHANNEL),
  activateAccount: (accountId) => ipcRenderer.invoke(ACCOUNT_ACTIVATE_CHANNEL, accountId),
  retryAccount: () => ipcRenderer.invoke(ACCOUNT_RETRY_CHANNEL),
  onAccountViewStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: AccountViewStatus): void => listener(status)
    ipcRenderer.on(ACCOUNT_VIEW_STATUS_EVENT, handler)
    return () => ipcRenderer.removeListener(ACCOUNT_VIEW_STATUS_EVENT, handler)
  }
})

if (process.isMainFrame) contextBridge.exposeInMainWorld('api', api)
