import type { AccountState } from './accounts'

export const APP_INFO_CHANNEL = 'hantong:app-info'
export const ACCOUNT_STATE_CHANNEL = 'hantong:accounts-get'
export const ACCOUNT_ADD_CHANNEL = 'hantong:accounts-add'
export const ACCOUNT_ACTIVATE_CHANNEL = 'hantong:accounts-activate'
export const ACCOUNT_RETRY_CHANNEL = 'hantong:accounts-retry'
export const ACCOUNT_REMOVE_CHANNEL = 'hantong:accounts-remove'
export const ACCOUNT_VIEW_STATUS_EVENT = 'hantong:account-view-status'
export const GOOGLE_CONNECTION_STATUS_CHANNEL = 'hantong:google-connection-status'
export const GOOGLE_CONNECTION_CONNECT_CHANNEL = 'hantong:google-connection-connect'
export const GOOGLE_CONNECTION_CANCEL_CHANNEL = 'hantong:google-connection-cancel'
export const GOOGLE_CONNECTION_DISCONNECT_CHANNEL = 'hantong:google-connection-disconnect'
export const ACCOUNT_CHROME_HEIGHT = 88

export type AccountViewStatus = {
  accountId: string
  status: 'loading' | 'ready' | 'error' | 'blocked'
}

export type AccountRemovalOutcome = 'removed' | 'cancelled' | 'failed'

export interface AccountRemovalResult {
  outcome: AccountRemovalOutcome
  state: AccountState
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

export interface HantongApi {
  getAppInfo: () => Promise<AppInfo>
  getAccounts: () => Promise<AccountState>
  addAccount: () => Promise<AccountState>
  activateAccount: (accountId: string) => Promise<AccountState>
  retryAccount: () => Promise<void>
  removeAccount: (accountId: string) => Promise<AccountRemovalResult>
  onAccountViewStatus: (listener: (status: AccountViewStatus) => void) => () => void
  getGoogleConnectionStatus: (accountId: string) => Promise<GoogleConnectionStatus>
  connectGoogleAccount: (accountId: string) => Promise<GoogleConnectionStatus>
  cancelGoogleConnection: (accountId: string) => Promise<GoogleConnectionStatus>
  disconnectGoogleAccount: (accountId: string) => Promise<GoogleConnectionStatus>
}
