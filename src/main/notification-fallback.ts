import type {
  NotificationConnectionEntry,
  RelayConfiguration
} from './notification-connection-types'

const FALLBACK_INTERVAL_MS = 60_000
const FALLBACK_BACKOFF_MS = [60_000, 120_000, 240_000, 480_000, 900_000] as const

export interface NotificationFallbackDependencies {
  readonly entries: () => Iterable<[string, NotificationConnectionEntry]>
  readonly currentEntry: (accountId: string) => NotificationConnectionEntry | undefined
  readonly relayConfiguration: () => RelayConfiguration
  readonly isSuspended: () => boolean
  readonly isDisposed: () => boolean
  readonly googleStatus: NotificationFallbackGoogleStatus
  readonly syncNow: (accountId: string) => void
  readonly requireGoogleAuth: (accountId: string, entry: NotificationConnectionEntry) => void
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

type NotificationFallbackGoogleStatus = (
  accountId: string
) => Promise<'connected' | 'reconnect_required' | 'disconnected' | 'unavailable'>

export interface NotificationFallback {
  ensure(accountId: string, entry: NotificationConnectionEntry): void
  clear(entry: NotificationConnectionEntry): void
  recordFailure(entry: NotificationConnectionEntry): void
  scheduleNext(accountId: string, entry: NotificationConnectionEntry): void
  scheduleBackoff(accountId: string, entry: NotificationConnectionEntry): void
  dispose(): void
}

export function createNotificationFallback(
  dependencies: NotificationFallbackDependencies
): NotificationFallback {
  const scheduleTimer = dependencies.setTimeout ?? setTimeout
  const clearTimer = dependencies.clearTimeout ?? clearTimeout
  let disposed = false

  const clear = (entry: NotificationConnectionEntry): void => {
    if (entry.fallbackTimer) clearTimer(entry.fallbackTimer)
    entry.fallbackTimer = undefined
  }

  const schedule = (accountId: string, entry: NotificationConnectionEntry, delay: number): void => {
    clear(entry)
    if (
      disposed ||
      dependencies.isDisposed() ||
      dependencies.isSuspended() ||
      dependencies.relayConfiguration() === 'disabled' ||
      entry.googleAuthRequired ||
      entry.state.status === 'connected'
    )
      return

    entry.fallbackTimer = scheduleTimer(
      () => {
        entry.fallbackTimer = undefined
        if (
          disposed ||
          dependencies.isDisposed() ||
          dependencies.isSuspended() ||
          dependencies.currentEntry(accountId) !== entry ||
          entry.state.status === 'connected'
        )
          return
        const generation = entry.generation
        void dependencies
          .googleStatus(accountId)
          .then((status) => {
            if (
              disposed ||
              dependencies.isDisposed() ||
              dependencies.isSuspended() ||
              dependencies.currentEntry(accountId) !== entry ||
              generation !== entry.generation
            )
              return
            if (status !== 'connected') {
              if (status === 'reconnect_required' || status === 'disconnected') {
                dependencies.requireGoogleAuth(accountId, entry)
              } else {
                recordFailure(entry)
                scheduleBackoff(accountId, entry)
              }
              return
            }
            entry.fallbackInFlight = true
            dependencies.syncNow(accountId)
          })
          .catch(() => {
            if (
              disposed ||
              dependencies.isDisposed() ||
              dependencies.isSuspended() ||
              dependencies.currentEntry(accountId) !== entry ||
              generation !== entry.generation
            )
              return
            recordFailure(entry)
            scheduleBackoff(accountId, entry)
          })
      },
      Math.max(0, delay)
    )
  }

  const recordFailure = (entry: NotificationConnectionEntry): void => {
    entry.fallbackFailures += 1
  }

  const scheduleBackoff = (accountId: string, entry: NotificationConnectionEntry): void => {
    schedule(
      accountId,
      entry,
      FALLBACK_BACKOFF_MS[Math.min(entry.fallbackFailures - 1, FALLBACK_BACKOFF_MS.length - 1)]
    )
  }

  return {
    ensure(accountId, entry): void {
      if (
        disposed ||
        dependencies.isDisposed() ||
        dependencies.isSuspended() ||
        dependencies.relayConfiguration() === 'disabled' ||
        entry.state.status === 'connected' ||
        entry.state.status === 'disabled' ||
        entry.googleAuthRequired ||
        entry.fallbackTimer ||
        entry.fallbackInFlight
      ) {
        if (
          entry.state.status === 'connected' ||
          entry.state.status === 'disabled' ||
          dependencies.isSuspended() ||
          dependencies.isDisposed() ||
          disposed
        )
          clear(entry)
        return
      }
      schedule(accountId, entry, FALLBACK_INTERVAL_MS)
    },
    clear,
    recordFailure,
    scheduleNext(accountId, entry): void {
      schedule(accountId, entry, FALLBACK_INTERVAL_MS)
    },
    scheduleBackoff,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const [, entry] of dependencies.entries()) clear(entry)
    }
  }
}
