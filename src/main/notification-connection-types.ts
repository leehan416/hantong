import type { NotificationConnectionState, NotificationConnectionStates } from '../shared/ipc'

export type NotificationRelayFailureCode =
  'unauthorized' | 'forbidden' | 'invalid_response' | 'redirect_refused' | 'unavailable' | 'unknown'

export type NotificationConnectionEvent =
  | {
      readonly type: 'credentials'
      readonly accountId: string
      readonly outcome: 'missing' | 'read_success' | 'read_failure'
    }
  | {
      readonly type: 'credential_write'
      readonly accountId: string
      readonly outcome: 'success' | 'failure' | 'skipped'
    }
  | {
      readonly type: 'session'
      readonly accountId: string
      readonly outcome: 'started' | 'success' | 'failure' | 'blocked'
      readonly code?: NotificationRelayFailureCode
    }
  | {
      readonly type: 'google'
      readonly accountId: string
      readonly outcome: 'connected' | 'disconnected'
    }
  | {
      readonly type: 'transport'
      readonly accountId: string
      readonly outcome: 'ready' | 'closed' | 'failure'
    }
  | {
      readonly type: 'watch'
      readonly accountId: string
      readonly outcome: 'renewed' | 'retry' | 'blocked' | 'cancelled'
      readonly code?: NotificationRelayFailureCode
    }
  | {
      readonly type: 'history'
      readonly accountId: string
      readonly outcome: 'success' | 'null' | 'failure'
    }
  | { readonly type: 'unread'; readonly accountId: string; readonly outcome: 'success' | 'failure' }

export type RelayConfiguration = 'enabled' | 'disabled' | 'invalid'

export type NotificationConnectionEntry = {
  state: NotificationConnectionState
  persistedCredential: boolean
  credentialMissing: boolean
  storageError: boolean
  relayAuthRequired: boolean
  googleAuthRequired: boolean
  relayReady: boolean
  watchReady: boolean
  historyReady: boolean
  unreadReady: boolean
  alertPending: boolean
  alertShown: boolean
  fallbackTimer?: ReturnType<typeof setTimeout>
  fallbackFailures: number
  fallbackInFlight: boolean
  fallbackAwaitingUnread: boolean
  generation: number
  recoveryEpoch: number
}

export interface NotificationConnectionControllerDependencies {
  readonly accountExists: (accountId: string) => boolean
  readonly googleStatus: (
    accountId: string
  ) => Promise<'connected' | 'reconnect_required' | 'disconnected' | 'unavailable'>
  readonly syncNow: (accountId: string) => void
  readonly recover: (accountId: string) => Promise<void>
  readonly cancelRecovery: (accountId: string) => Promise<void>
  readonly reconnectRelay: (accountId: string) => Promise<void>
  readonly canAlert: (accountId: string) => boolean
  readonly alert: (accountId: string, status: 'reconnect_required' | 'storage_error') => void
  readonly publish: (snapshot: NotificationConnectionStates) => void
  readonly now: () => number
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

export interface NotificationConnectionController {
  configure(input: {
    relay: RelayConfiguration
    watchConfigured: boolean
    accountIds: readonly string[]
  }): void
  event(event: NotificationConnectionEvent): void
  snapshot(): NotificationConnectionStates
  recover(accountId: string): Promise<void>
  cancel(accountId: string): Promise<void>
  retry(accountId: string): Promise<void>
  flushAlerts(): void
  suspend(): void
  resume(accountIds: readonly string[]): void
  disconnect(accountId: string): void
  dispose(): void
}
