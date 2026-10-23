import { isAccountId } from './account-state'
import { createNotificationFallback } from './notification-fallback'
import type {
  NotificationConnectionController,
  NotificationConnectionControllerDependencies,
  NotificationConnectionEntry,
  NotificationConnectionEvent,
  NotificationRelayFailureCode,
  RelayConfiguration
} from './notification-connection-types'
import type { NotificationConnectionState, NotificationConnectionStates } from '../shared/ipc'

export type {
  NotificationConnectionController,
  NotificationConnectionControllerDependencies,
  NotificationConnectionEvent,
  NotificationRelayFailureCode
} from './notification-connection-types'

type Entry = NotificationConnectionEntry

export function notificationRelayFailureCode(value: unknown): NotificationRelayFailureCode {
  if (
    value === 'unauthorized' ||
    value === 'forbidden' ||
    value === 'invalid_response' ||
    value === 'redirect_refused' ||
    value === 'unavailable'
  )
    return value
  return 'unknown'
}

export function createNotificationConnectionController(
  dependencies: NotificationConnectionControllerDependencies
): NotificationConnectionController {
  const entries = new Map<string, Entry>()
  let relay: RelayConfiguration = 'disabled'
  let watchConfigured = false
  let suspended = false
  let disposed = false
  const fallback = createNotificationFallback({
    entries: () => entries,
    currentEntry: (accountId) => entries.get(accountId),
    relayConfiguration: () => relay,
    isSuspended: () => suspended,
    isDisposed: () => disposed,
    googleStatus: dependencies.googleStatus,
    syncNow: dependencies.syncNow,
    requireGoogleAuth: (accountId, entry) => {
      entry.googleAuthRequired = true
      setStatus(accountId, entry, 'reconnect_required')
    },
    setTimeout: dependencies.setTimeout,
    clearTimeout: dependencies.clearTimeout
  })

  const snapshot = (): NotificationConnectionStates => {
    const result: NotificationConnectionStates = {}
    for (const [accountId, entry] of entries) result[accountId] = { ...entry.state }
    return result
  }
  const publish = (): void => {
    try {
      dependencies.publish(snapshot())
    } catch {
      /* advisory */
    }
  }
  const statusFor = (
    entry: Entry,
    proposed: NotificationConnectionState['status']
  ): NotificationConnectionState['status'] => {
    if (entry.storageError) return 'storage_error'
    if (entry.credentialMissing || entry.relayAuthRequired || entry.googleAuthRequired)
      return 'reconnect_required'
    return proposed
  }
  const flushAlert = (accountId: string, entry: Entry): void => {
    if (
      !entry.alertPending ||
      entry.alertShown ||
      entry.state.recovering ||
      (entry.state.status !== 'reconnect_required' && entry.state.status !== 'storage_error')
    )
      return
    let allowed: boolean
    try {
      allowed = dependencies.canAlert(accountId)
    } catch {
      allowed = false
    }
    if (!allowed) return
    entry.alertPending = false
    entry.alertShown = true
    try {
      dependencies.alert(accountId, entry.state.status)
    } catch {
      /* banner remains available */
    }
  }
  const setStatus = (
    accountId: string,
    entry: Entry,
    proposed: NotificationConnectionState['status']
  ): void => {
    const status = statusFor(entry, proposed)
    const previous = entry.state.status
    if (previous !== status) entry.state = { ...entry.state, status }
    if (status === 'connected') {
      entry.state = { ...entry.state, recovering: false }
      entry.alertPending = false
      entry.alertShown = false
      entry.fallbackFailures = 0
      entry.fallbackInFlight = false
      entry.fallbackAwaitingUnread = false
      clearTimer(entry)
    } else if (status === 'reconnect_required' || status === 'storage_error') {
      entry.alertPending = true
      flushAlert(accountId, entry)
    }
    if (previous !== status) publish()
    ensureFallback(accountId, entry)
  }
  const clearTimer = (entry: Entry): void => fallback.clear(entry)
  const ensureFallback = (accountId: string, entry: Entry): void =>
    fallback.ensure(accountId, entry)
  const getOrCreate = (accountId: string): Entry | undefined => {
    if (!isAccountId(accountId) || !dependencies.accountExists(accountId)) return undefined
    const existing = entries.get(accountId)
    if (existing) return existing
    const status =
      relay === 'disabled' ? 'disabled' : relay === 'invalid' ? 'unavailable' : 'connecting'
    const entry: Entry = {
      state: { accountId, status, recovering: false },
      persistedCredential: false,
      credentialMissing: false,
      storageError: false,
      relayAuthRequired: false,
      googleAuthRequired: false,
      relayReady: false,
      watchReady: !watchConfigured,
      historyReady: false,
      unreadReady: false,
      alertPending: false,
      alertShown: false,
      fallbackFailures: 0,
      fallbackInFlight: false,
      fallbackAwaitingUnread: false,
      generation: 0,
      recoveryEpoch: 0
    }
    entries.set(accountId, entry)
    ensureFallback(accountId, entry)
    return entry
  }
  const maybeConnected = (accountId: string, entry: Entry): void => {
    if (
      entry.persistedCredential &&
      entry.relayReady &&
      entry.watchReady &&
      entry.historyReady &&
      entry.unreadReady
    )
      setStatus(accountId, entry, 'connected')
  }
  const flushAlerts = (): void => {
    for (const [id, entry] of entries) flushAlert(id, entry)
  }

  return {
    configure(input: {
      relay: RelayConfiguration
      watchConfigured: boolean
      accountIds: readonly string[]
    }): void {
      if (disposed) return
      relay = input.relay
      watchConfigured = input.watchConfigured
      for (const id of input.accountIds) {
        const entry = getOrCreate(id)
        if (!entry) continue
        entry.watchReady = !watchConfigured
        if (relay === 'disabled') setStatus(id, entry, 'disabled')
        else if (relay === 'invalid') setStatus(id, entry, 'unavailable')
        else setStatus(id, entry, 'connecting')
      }
      publish()
    },
    event(event: NotificationConnectionEvent): void {
      if (disposed || !isAccountId(event.accountId) || !dependencies.accountExists(event.accountId))
        return
      const entry = getOrCreate(event.accountId)
      if (!entry) return
      switch (event.type) {
        case 'credentials':
          if (event.outcome === 'missing') {
            entry.persistedCredential = false
            entry.credentialMissing = true
            setStatus(event.accountId, entry, 'reconnect_required')
          } else if (event.outcome === 'read_failure') {
            entry.storageError = true
            setStatus(event.accountId, entry, 'storage_error')
          } else {
            entry.persistedCredential = true
            entry.storageError = false
            setStatus(event.accountId, entry, 'connecting')
          }
          return
        case 'credential_write':
          if (event.outcome === 'failure') {
            entry.persistedCredential = false
            entry.storageError = true
            setStatus(event.accountId, entry, 'storage_error')
          } else if (event.outcome === 'success') {
            entry.persistedCredential = true
            entry.storageError = false
            entry.credentialMissing = false
            setStatus(event.accountId, entry, 'connecting')
            maybeConnected(event.accountId, entry)
          } else if (!entry.persistedCredential) setStatus(event.accountId, entry, 'unavailable')
          return
        case 'session':
          if (event.outcome === 'blocked') {
            entry.relayAuthRequired = !event.code || event.code === 'unauthorized'
            setStatus(
              event.accountId,
              entry,
              entry.relayAuthRequired ? 'reconnect_required' : 'unavailable'
            )
          } else if (event.outcome === 'success') {
            entry.relayAuthRequired = false
            setStatus(event.accountId, entry, 'connecting')
          } else if (event.outcome === 'failure') setStatus(event.accountId, entry, 'retrying')
          else setStatus(event.accountId, entry, 'connecting')
          return
        case 'google':
          entry.googleAuthRequired = event.outcome === 'disconnected'
          setStatus(
            event.accountId,
            entry,
            event.outcome === 'disconnected' ? 'reconnect_required' : 'connecting'
          )
          return
        case 'transport':
          if (event.outcome === 'ready') {
            entry.relayReady = true
            entry.historyReady = false
            entry.unreadReady = false
            entry.watchReady = !watchConfigured
            setStatus(event.accountId, entry, 'connecting')
          } else {
            entry.relayReady = false
            setStatus(event.accountId, entry, 'retrying')
          }
          return
        case 'watch':
          if (event.outcome === 'renewed') {
            entry.watchReady = true
            maybeConnected(event.accountId, entry)
          } else if (event.outcome === 'blocked') {
            entry.watchReady = false
            if (event.code === 'unauthorized') entry.googleAuthRequired = true
            setStatus(
              event.accountId,
              entry,
              event.code === 'unauthorized' ? 'reconnect_required' : 'unavailable'
            )
          } else if (event.outcome === 'retry') {
            entry.watchReady = false
            setStatus(event.accountId, entry, 'retrying')
          }
          return
        case 'history':
          if (event.outcome === 'success' || event.outcome === 'null') {
            entry.historyReady = true
            if (entry.fallbackInFlight && event.outcome === 'success')
              entry.fallbackAwaitingUnread = true
            else if (entry.fallbackInFlight) {
              entry.fallbackInFlight = false
              fallback.scheduleNext(event.accountId, entry)
            }
            maybeConnected(event.accountId, entry)
          } else {
            entry.historyReady = false
            entry.fallbackInFlight = false
            fallback.recordFailure(entry)
            setStatus(event.accountId, entry, 'retrying')
            fallback.scheduleBackoff(event.accountId, entry)
          }
          return
        case 'unread':
          if (event.outcome === 'success') {
            entry.unreadReady = true
            if (entry.fallbackInFlight && entry.fallbackAwaitingUnread) {
              entry.fallbackInFlight = false
              entry.fallbackAwaitingUnread = false
              entry.fallbackFailures = 0
              fallback.scheduleNext(event.accountId, entry)
            }
            maybeConnected(event.accountId, entry)
          } else {
            entry.unreadReady = false
            entry.fallbackInFlight = false
            fallback.recordFailure(entry)
            setStatus(event.accountId, entry, 'retrying')
            fallback.scheduleBackoff(event.accountId, entry)
          }
          return
      }
    },
    snapshot,
    async recover(accountId: string): Promise<void> {
      const entry = getOrCreate(accountId)
      if (!entry || relay !== 'enabled' || entry.state.recovering) return
      const generation = entry.generation
      const recoveryEpoch = ++entry.recoveryEpoch
      entry.state = { ...entry.state, recovering: true }
      publish()
      try {
        await dependencies.recover(accountId)
        if (
          entries.get(accountId) === entry &&
          entry.generation === generation &&
          entry.recoveryEpoch === recoveryEpoch
        ) {
          entry.googleAuthRequired = false
          setStatus(accountId, entry, 'connecting')
        }
      } catch {
        if (
          entries.get(accountId) === entry &&
          entry.generation === generation &&
          entry.recoveryEpoch === recoveryEpoch
        )
          setStatus(accountId, entry, 'reconnect_required')
      } finally {
        if (
          entries.get(accountId) === entry &&
          entry.generation === generation &&
          entry.recoveryEpoch === recoveryEpoch
        ) {
          entry.state = { ...entry.state, recovering: false }
          publish()
          flushAlerts()
        }
      }
    },
    async cancel(accountId: string): Promise<void> {
      const entry = entries.get(accountId)
      if (!entry) return
      const generation = entry.generation
      const recoveryEpoch = ++entry.recoveryEpoch
      entry.state = { ...entry.state, recovering: false }
      publish()
      try {
        await dependencies.cancelRecovery(accountId)
      } finally {
        if (
          entries.get(accountId) === entry &&
          entry.generation === generation &&
          entry.recoveryEpoch === recoveryEpoch
        ) {
          setStatus(accountId, entry, 'reconnect_required')
          flushAlerts()
        }
      }
    },
    async retry(accountId: string): Promise<void> {
      const entry = getOrCreate(accountId)
      if (!entry || relay === 'disabled') return
      if (relay === 'invalid') {
        dependencies.syncNow(accountId)
        ensureFallback(accountId, entry)
        return
      }
      const generation = entry.generation
      setStatus(accountId, entry, 'connecting')
      try {
        await dependencies.reconnectRelay(accountId)
        if (entries.get(accountId) === entry && entry.generation === generation)
          dependencies.syncNow(accountId)
      } catch {
        if (entries.get(accountId) === entry && entry.generation === generation)
          setStatus(accountId, entry, 'retrying')
      }
    },
    flushAlerts,
    suspend(): void {
      if (disposed || suspended) return
      suspended = true
      for (const entry of entries.values()) {
        clearTimer(entry)
        entry.generation++
        entry.fallbackInFlight = false
      }
    },
    resume(accountIds: readonly string[]): void {
      if (disposed) return
      suspended = false
      for (const id of accountIds) {
        const entry = getOrCreate(id)
        if (!entry || entry.state.status === 'disabled') continue
        entry.generation++
        entry.relayReady = false
        entry.historyReady = false
        entry.unreadReady = false
        entry.watchReady = !watchConfigured
        entry.fallbackInFlight = false
        entry.fallbackAwaitingUnread = false
        setStatus(id, entry, relay === 'invalid' ? 'unavailable' : 'retrying')
        const generation = entry.generation
        const reconnect =
          relay === 'enabled'
            ? dependencies.reconnectRelay(id).catch(() => undefined)
            : Promise.resolve()
        void reconnect.finally(() => {
          if (
            !disposed &&
            !suspended &&
            entries.get(id) === entry &&
            entry.generation === generation
          )
            dependencies.syncNow(id)
        })
        ensureFallback(id, entry)
      }
      flushAlerts()
    },
    disconnect(accountId: string): void {
      const entry = entries.get(accountId)
      if (entry) {
        entry.generation++
        clearTimer(entry)
      }
      entries.delete(accountId)
      publish()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const entry of entries.values()) {
        entry.generation++
      }
      fallback.dispose()
      entries.clear()
    }
  }
}
