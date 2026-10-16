import type { AccountState } from './accounts'

export const APP_INFO_CHANNEL = 'hantong:app-info'
export const ACCOUNT_STATE_CHANNEL = 'hantong:accounts-get'
export const ACCOUNT_ADD_CHANNEL = 'hantong:accounts-add'
export const ACCOUNT_ACTIVATE_CHANNEL = 'hantong:accounts-activate'
export const ACCOUNT_RETRY_CHANNEL = 'hantong:accounts-retry'
export const ACCOUNT_REMOVE_CHANNEL = 'hantong:accounts-remove'
export const ACCOUNT_VIEW_STATUS_EVENT = 'hantong:account-view-status'
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

export interface HantongApi {
  getAppInfo: () => Promise<AppInfo>
  getAccounts: () => Promise<AccountState>
  addAccount: () => Promise<AccountState>
  activateAccount: (accountId: string) => Promise<AccountState>
  retryAccount: () => Promise<void>
  removeAccount: (accountId: string) => Promise<AccountRemovalResult>
  onAccountViewStatus: (listener: (status: AccountViewStatus) => void) => () => void
}
