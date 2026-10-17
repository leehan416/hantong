import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_REMOVE_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STATE_EVENT,
  UNREAD_COUNTS_CHANNEL,
  UNREAD_COUNTS_EVENT,
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  SETTINGS_EVENT,
  SETTINGS_PANEL_CHANNEL,
  SETTINGS_OPEN_EVENT,
  ACCOUNT_VIEW_STATUS_EVENT,
  ACCOUNT_ACCESS_STATE_CHANNEL,
  ACCOUNT_ACCESS_STATE_EVENT,
  APP_INFO_CHANNEL,
  GOOGLE_CONNECTION_CANCEL_CHANNEL,
  GOOGLE_CONNECTION_CONNECT_CHANNEL,
  GOOGLE_CONNECTION_DISCONNECT_CHANNEL,
  GOOGLE_CONNECTION_STATUS_CHANNEL,
  type AccountViewStatus,
  type UnreadCounts,
  type AccountAccessState,
  type HantongApi
} from '../shared/ipc'
import type { AccountState } from '../shared/accounts'
import type { AppSettings } from '../shared/settings'

if (!process.contextIsolated) throw new Error('Context isolation is required')

// Expose operations rather than a generic channel sender or Electron objects.
const api: HantongApi = Object.freeze({
  getAppInfo: () => ipcRenderer.invoke(APP_INFO_CHANNEL),
  getGoogleConnectionStatus: (accountId) =>
    ipcRenderer.invoke(GOOGLE_CONNECTION_STATUS_CHANNEL, accountId),
  connectGoogleAccount: (accountId) =>
    ipcRenderer.invoke(GOOGLE_CONNECTION_CONNECT_CHANNEL, accountId),
  cancelGoogleConnection: (accountId) =>
    ipcRenderer.invoke(GOOGLE_CONNECTION_CANCEL_CHANNEL, accountId),
  disconnectGoogleAccount: (accountId) =>
    ipcRenderer.invoke(GOOGLE_CONNECTION_DISCONNECT_CHANNEL, accountId),
  getAccounts: () => ipcRenderer.invoke(ACCOUNT_STATE_CHANNEL),
  addAccount: () => ipcRenderer.invoke(ACCOUNT_ADD_CHANNEL),
  removeAccount: (accountId) => ipcRenderer.invoke(ACCOUNT_REMOVE_CHANNEL, accountId),
  activateAccount: (accountId) => ipcRenderer.invoke(ACCOUNT_ACTIVATE_CHANNEL, accountId),
  retryAccount: () => ipcRenderer.invoke(ACCOUNT_RETRY_CHANNEL),
  onAccountViewStatus: (listener) => {
    const handler = (_event: IpcRendererEvent, status: AccountViewStatus): void => listener(status)
    ipcRenderer.on(ACCOUNT_VIEW_STATUS_EVENT, handler)
    return () => ipcRenderer.removeListener(ACCOUNT_VIEW_STATUS_EVENT, handler)
  },
  onAccountState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AccountState): void => listener(state)
    ipcRenderer.on(ACCOUNT_STATE_EVENT, handler)
    return () => ipcRenderer.removeListener(ACCOUNT_STATE_EVENT, handler)
  },
  getUnreadCounts: () => ipcRenderer.invoke(UNREAD_COUNTS_CHANNEL),
  onUnreadCounts: (listener) => {
    const handler = (_event: IpcRendererEvent, counts: UnreadCounts): void => listener(counts)
    ipcRenderer.on(UNREAD_COUNTS_EVENT, handler)
    return () => ipcRenderer.removeListener(UNREAD_COUNTS_EVENT, handler)
  },
  getSettings: () => ipcRenderer.invoke(SETTINGS_GET_CHANNEL),
  updateSettings: (patch) => ipcRenderer.invoke(SETTINGS_UPDATE_CHANNEL, patch),
  setSettingsPanelOpen: (open) => ipcRenderer.invoke(SETTINGS_PANEL_CHANNEL, open),
  onOpenSettings: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on(SETTINGS_OPEN_EVENT, handler)
    return () => ipcRenderer.removeListener(SETTINGS_OPEN_EVENT, handler)
  },
  onSettings: (listener) => {
    const handler = (_event: IpcRendererEvent, settings: AppSettings): void => listener(settings)
    ipcRenderer.on(SETTINGS_EVENT, handler)
    return () => ipcRenderer.removeListener(SETTINGS_EVENT, handler)
  },
  getAccountAccessState: (accountId) => ipcRenderer.invoke(ACCOUNT_ACCESS_STATE_CHANNEL, accountId),
  onAccountAccessState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: AccountAccessState): void => listener(state)
    ipcRenderer.on(ACCOUNT_ACCESS_STATE_EVENT, handler)
    return () => ipcRenderer.removeListener(ACCOUNT_ACCESS_STATE_EVENT, handler)
  }
})

if (process.isMainFrame) contextBridge.exposeInMainWorld('api', api)
