import type { HantongApi } from '~/shared/ipc'

export type AccountsApi = Pick<
  HantongApi,
  | 'onAccountViewStatus'
  | 'onAccountState'
  | 'onUnreadCounts'
  | 'getAppInfo'
  | 'getAccounts'
  | 'getUnreadCounts'
  | 'addAccount'
  | 'activateAccount'
  | 'moveAccount'
  | 'removeAccount'
  | 'retryAccount'
  | 'setAccountDisplayName'
  | 'updateAccountColor'
  | 'setAccountNotificationsEnabled'
>

export function getAccountsApi(): AccountsApi {
  return window.api
}
