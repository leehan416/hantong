import type { AccountColor, AccountState } from './accounts'
import type { AppSettings, AppSettingsPatch } from './settings'

export const APP_INFO_CHANNEL = 'hantong:app-info'
export const ACCOUNT_STATE_CHANNEL = 'hantong:accounts-get'
export const ACCOUNT_ADD_CHANNEL = 'hantong:accounts-add'
export const ACCOUNT_ACTIVATE_CHANNEL = 'hantong:accounts-activate'
export const ACCOUNT_RETRY_CHANNEL = 'hantong:accounts-retry'
export const ACCOUNT_REMOVE_CHANNEL = 'hantong:accounts-remove'
export const ACCOUNT_DISPLAY_NAME_CHANNEL = 'hantong:accounts-display-name'
export const ACCOUNT_COLOR_CHANNEL = 'hantong:accounts-color'
export const ACCOUNT_MOVE_CHANNEL = 'hantong:accounts-move'
export const ACCOUNT_VIEW_STATUS_EVENT = 'hantong:account-view-status'
export const ACCOUNT_STATE_EVENT = 'hantong:accounts-change'
export const UNREAD_COUNTS_CHANNEL = 'hantong:unread-counts-get'
export const UNREAD_COUNTS_EVENT = 'hantong:unread-counts-change'
export const SETTINGS_GET_CHANNEL = 'hantong:settings-get'
export const SETTINGS_UPDATE_CHANNEL = 'hantong:settings-update'
export const SETTINGS_EVENT = 'hantong:settings-change'
export const SETTINGS_PANEL_CHANNEL = 'hantong:settings-panel'
export const ACCOUNT_STATUS_STRIP_CHANNEL = 'hantong:account-status-strip'
export const SETTINGS_OPEN_EVENT = 'hantong:settings-open'
export const GOOGLE_CONNECTION_STATUS_CHANNEL = 'hantong:google-connection-status'
export const GOOGLE_CONNECTION_CONNECT_CHANNEL = 'hantong:google-connection-connect'
export const GOOGLE_CONNECTION_CANCEL_CHANNEL = 'hantong:google-connection-cancel'
export const GOOGLE_CONNECTION_DISCONNECT_CHANNEL = 'hantong:google-connection-disconnect'
export const ACCOUNT_ACCESS_STATE_CHANNEL = 'hantong:account-access-state'
export const ACCOUNT_ACCESS_STATE_EVENT = 'hantong:account-access-state-change'
export const ACCOUNT_CHROME_HEIGHT = 72
export const ACCOUNT_STATUS_STRIP_HEIGHT = 32
export const ACCOUNT_SIDEBAR_WIDTH = 248
export const ACCOUNT_SIDEBAR_COLLAPSED_WIDTH = 56

export type AccountViewStatus = {
  accountId: string
  status: 'loading' | 'ready' | 'error' | 'blocked'
}

export type AccountRemovalOutcome = 'removed' | 'cancelled' | 'failed'

export interface AccountRemovalResult {
  outcome: AccountRemovalOutcome
  state: AccountState
}

// Inbox unread count per account id; accounts without a known count are absent.
export type UnreadCounts = Record<string, number>

export interface AccountViewSnapshot {
  accountId: string
  bounds: { x: number; y: number; width: number; height: number }
  dataUrl: string
}

export interface AppInfo {
  name: string
  version: string
  locale: 'ko' | 'en'
}

export type GoogleConnectionStatus = {
  accountId: string
  status: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
}

export type AccountAccessState = {
  accountId: string
  status: 'sign_in' | 'checking' | 'required' | 'ready' | 'error'
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'reconnect_required' | 'error'
}

export interface HantongApi {
  getAppInfo: () => Promise<AppInfo>
  getAccounts: () => Promise<AccountState>
  addAccount: () => Promise<AccountState>
  activateAccount: (accountId: string) => Promise<AccountState>
  setAccountDisplayName: (accountId: string, displayName: string | null) => Promise<AccountState>
  updateAccountColor: (accountId: string, color: AccountColor) => Promise<AccountState>
  moveAccount: (accountId: string, toIndex: number) => Promise<AccountState>
  retryAccount: () => Promise<void>
  removeAccount: (accountId: string) => Promise<AccountRemovalResult>
  onAccountViewStatus: (listener: (status: AccountViewStatus) => void) => () => void
  onAccountState: (listener: (state: AccountState) => void) => () => void
  getUnreadCounts: () => Promise<UnreadCounts>
  onUnreadCounts: (listener: (counts: UnreadCounts) => void) => () => void
  getSettings: () => Promise<AppSettings>
  updateSettings: (patch: AppSettingsPatch) => Promise<AppSettings>
  onSettings: (listener: (settings: AppSettings) => void) => () => void
  setSettingsPanelOpen: (open: boolean) => Promise<AccountViewSnapshot | null>
  setStatusStripVisible: (visible: boolean) => Promise<void>
  onOpenSettings: (listener: () => void) => () => void
  getGoogleConnectionStatus: (accountId: string) => Promise<GoogleConnectionStatus>
  connectGoogleAccount: (accountId: string) => Promise<GoogleConnectionStatus>
  cancelGoogleConnection: (accountId: string) => Promise<GoogleConnectionStatus>
  disconnectGoogleAccount: (accountId: string) => Promise<GoogleConnectionStatus>
  getAccountAccessState: (accountId: string) => Promise<AccountAccessState>
  onAccountAccessState: (listener: (state: AccountAccessState) => void) => () => void
}
