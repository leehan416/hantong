import type { HantongApi } from '~/shared/ipc'

export type ConnectionsApi = Pick<
  HantongApi,
  | 'getGoogleConnectionStatus'
  | 'connectGoogleAccount'
  | 'cancelGoogleConnection'
  | 'disconnectGoogleAccount'
  | 'getAccountAccessState'
  | 'onAccountAccessState'
  | 'getNotificationConnections'
  | 'onNotificationConnections'
  | 'recoverNotifications'
  | 'cancelNotificationRecovery'
  | 'retryNotifications'
>

export function getConnectionsApi(): ConnectionsApi {
  return window.api
}
