import type { GmailHistorySyncResult } from './gmail-history-sync'
import type { GmailWatchManager } from './gmail-watch-manager'
import type { RelaySignal } from './relay-client'

export interface GmailRelaySyncDependencies {
  readonly sync: (accountId: string) => Promise<GmailHistorySyncResult | null>
  readonly resetSync: (accountId: string) => void
  // Absent when no Pub/Sub topic is configured; history still syncs on relay hints.
  readonly watch?: GmailWatchManager
  readonly now: () => number
  readonly onChanges: (accountId: string, result: GmailHistorySyncResult) => void
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

export function createGmailRelaySync(dependencies: GmailRelaySyncDependencies): {
  onSignal(accountId: string, event: RelaySignal): void
  disconnect(accountId: string): void
  dispose(): void
} {
  const schedule = dependencies.setTimeout ?? setTimeout
  const unschedule = dependencies.clearTimeout ?? clearTimeout
  // Each pass gets its own marker so a pass that outlives disconnect cannot clear its successor.
  const running = new Map<string, object>()
  const rerun = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  // A hint that lands while a pass is in flight may postdate its history read, so run once more.
  const sync = (accountId: string): void => {
    if (disposed) return
    if (running.has(accountId)) {
      rerun.add(accountId)
      return
    }
    const pass = {}
    running.set(accountId, pass)
    void Promise.resolve()
      .then(() => dependencies.sync(accountId))
      .then((result) => {
        if (result && !disposed && running.get(accountId) === pass) {
          dependencies.onChanges(accountId, result)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (running.get(accountId) !== pass) return
        running.delete(accountId)
        if (rerun.delete(accountId)) sync(accountId)
      })
  }

  const armWatchTimer = (): void => {
    if (timer) unschedule(timer)
    timer = undefined
    const dueAt = disposed ? null : (dependencies.watch?.getNextDueAt() ?? null)
    if (dueAt === null) return
    // Renewals are at most a day apart, well below the platform timer limit.
    timer = schedule(
      () => {
        timer = undefined
        runWatch(() => dependencies.watch?.runDue(dependencies.now()))
      },
      Math.max(0, dueAt - dependencies.now())
    )
  }

  const runWatch = (start: () => Promise<unknown> | undefined): void => {
    if (disposed) return
    let pending: Promise<unknown> | undefined
    try {
      pending = start()
    } catch {
      pending = undefined
    }
    void Promise.resolve(pending)
      .catch(() => undefined)
      .finally(armWatchTimer)
  }

  return {
    onSignal(accountId, event): void {
      if (disposed) return
      if (event.type === 'ready') {
        runWatch(() => dependencies.watch?.connect(accountId, dependencies.now()))
      }
      sync(accountId)
    },
    disconnect(accountId): void {
      running.delete(accountId)
      rerun.delete(accountId)
      try {
        dependencies.watch?.disconnect(accountId)
      } catch {
        // An unknown account has no watch entry to drop.
      }
      try {
        // Forget the cursor so a later reconnect takes a silent baseline instead of replaying the gap.
        dependencies.resetSync(accountId)
      } catch {
        // Cursor cleanup failure leaves the old cursor; the next sync still fences by account.
      }
      armWatchTimer()
    },
    dispose(): void {
      disposed = true
      running.clear()
      rerun.clear()
      dependencies.watch?.dispose()
      armWatchTimer()
    }
  }
}
