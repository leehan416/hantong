import type {
  AccountSnapshot,
  MainDiagnosticEvent,
  MainDiagnosticRecord,
  MainDiagnosticsOptions,
  MainDiagnosticsSnapshot
} from './main-diagnostics-types'
import { isEvent, safeCode, safeOutcome } from './main-diagnostics-validation'

export * from './main-diagnostics-types'
export { createRotatingDiagnosticsSink } from './main-diagnostics-sink'
export { relayDiagnosticCode } from './main-diagnostics-validation'

function safeNow(now: () => number): number {
  try {
    const value = now()
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

export function createMainDiagnostics(options: MainDiagnosticsOptions): {
  record(event: MainDiagnosticEvent): void
  forget(accountId: string): void
  snapshot(): MainDiagnosticsSnapshot
} {
  const maxEvents = Math.max(1, Math.min(1000, options.maxEvents ?? 200))
  const maxAccounts = Math.max(1, Math.min(100, options.maxAccounts ?? 20))
  const heartbeatThrottleMs = options.heartbeatThrottleMs ?? 60_000
  const receiveThrottleMs = options.receiveThrottleMs ?? 30_000
  const aliases = new Map<string, string>()
  let nextAlias = 1
  const lastPersisted = new Map<string, number>()
  const events: MainDiagnosticRecord[] = []
  const accounts: Record<string, AccountSnapshot> = Object.create(null) as Record<
    string,
    AccountSnapshot
  >

  const aliasFor = (accountId: string): string | undefined => {
    if (!accountId) return undefined
    const existing = aliases.get(accountId)
    if (existing) return existing
    if (aliases.size >= maxAccounts) return undefined
    const alias = `account-${nextAlias++}`
    aliases.set(accountId, alias)
    accounts[alias] = {}
    return alias
  }

  const project = (
    event: MainDiagnosticEvent,
    at: number,
    account?: string
  ): MainDiagnosticRecord => {
    switch (event.type) {
      case 'oauth.progress':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          stage: event.stage,
          outcome: event.outcome,
          ...(event.code ? { code: event.code } : {})
        }
      case 'gmail.load.failure':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {})
        }
      case 'gmail.process.gone':
        return { at, type: event.type, ...(account ? { account } : {}), reason: event.reason }
      case 'gmail.load.timeout':
        return { at, type: event.type, ...(account ? { account } : {}) }
      case 'gmail.navigation.blocked':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          source: event.source,
          context: event.context,
          hostname: event.hostname,
          route: event.route,
          reason: event.reason
        }
      case 'relay.failure':
        return { at, type: event.type, ...(account ? { account } : {}), code: safeCode(event.code) }
      case 'relay.retry':
        return { at, type: event.type, ...(account ? { account } : {}), code: safeCode(event.code) }
      case 'relay.session':
      case 'relay.refresh':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          outcome: safeOutcome(event.outcome),
          ...(event.code ? { code: safeCode(event.code) } : {})
        }
      case 'relay.bootstrap':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          stage: event.stage,
          outcome: event.outcome,
          ...(event.code ? { code: safeCode(event.code) } : {})
        }
      case 'sync.success':
        return { at, type: event.type, ...(account ? { account } : {}), kind: event.kind }
      case 'watch.renewed':
        return { at, type: event.type, ...(account ? { account } : {}), expiresAt: event.expiresAt }
      case 'watch.retry':
      case 'watch.blocked':
      case 'watch.cancelled':
        return {
          at,
          type: event.type,
          ...(account ? { account } : {}),
          nextAttemptAt: event.nextAttemptAt
        }
      case 'unread.applied':
        return { at, type: event.type, ...(account ? { account } : {}), count: event.count }
      default:
        return { at, type: event.type, ...(account ? { account } : {}) }
    }
  }

  const record = (event: MainDiagnosticEvent): void => {
    try {
      if (!isEvent(event)) return
      const at = safeNow(options.now)
      const account =
        'accountId' in event && event.accountId ? aliasFor(event.accountId) : undefined
      if ('accountId' in event && event.accountId && !account) return
      const diagnostic = project(event, at, account)
      const routine = event.type === 'relay.heartbeat' || event.type === 'relay.receive'
      const throttle = event.type === 'relay.heartbeat' ? heartbeatThrottleMs : receiveThrottleMs
      const key = routine && account ? `${account}:${event.type}` : undefined
      if (key) {
        const previous = lastPersisted.get(key)
        if (previous !== undefined && at - previous < throttle) {
          updateSnapshot(event, at, account)
          return
        }
      }
      events.push(diagnostic)
      if (key) lastPersisted.set(key, at)
      if (events.length > maxEvents) events.splice(0, events.length - maxEvents)
      updateSnapshot(event, at, account)
      try {
        options.observe?.(event)
      } catch {
        // Diagnostics are advisory and must not interrupt mail flow.
      }
      try {
        const appended = options.sink?.append(`${JSON.stringify(diagnostic)}\n`)
        if (appended && typeof appended.then === 'function') {
          void appended.catch(() => undefined)
          if (options.sink?.flush) void options.sink.flush().catch(() => undefined)
        }
      } catch {
        // Local disk failures must not interrupt mail flow.
      }
    } catch {
      // Malformed diagnostic input is discarded.
    }
  }

  const updateSnapshot = (event: MainDiagnosticEvent, at: number, account?: string): void => {
    if (!account) return
    const target = accounts[account]
    if (!target) return
    switch (event.type) {
      case 'relay.ready':
        target.relay = { ...target.relay, readyAt: at }
        if (target.relay.closedAt === undefined) delete target.relay.closedAt
        break
      case 'relay.receive':
        target.relay = { ...target.relay, lastReceiveAt: at }
        break
      case 'relay.heartbeat':
        target.relay = { ...target.relay, heartbeatAt: at }
        break
      case 'relay.failure':
        target.relay = { ...target.relay, lastFailure: event.code }
        break
      case 'relay.retry':
        target.relay = { ...target.relay, lastFailure: event.code }
        break
      case 'sync.success':
        target.sync = { at, outcome: 'success', lastSuccessAt: at, kind: event.kind }
        break
      case 'sync.null':
        target.sync = { ...target.sync, at, outcome: 'null' }
        break
      case 'sync.failure':
        target.sync = { ...target.sync, at, outcome: 'failure' }
        break
      case 'watch.renewed':
        target.watch = {
          ...target.watch,
          at,
          outcome: 'renewed',
          expiresAt: event.expiresAt,
          lastSuccessAt: at
        }
        break
      case 'watch.retry':
      case 'watch.blocked':
      case 'watch.cancelled':
        target.watch = {
          ...target.watch,
          at,
          outcome: event.type.slice('watch.'.length) as 'retry' | 'blocked' | 'cancelled',
          nextAttemptAt: event.nextAttemptAt
        }
        break
      case 'unread.success':
        target.unread = { ...target.unread, at, outcome: 'success', lastSuccessAt: at }
        break
      case 'unread.failure':
        target.unread = { ...target.unread, at, outcome: 'failure' }
        break
      case 'unread.applied':
        target.unread = {
          ...target.unread,
          at,
          outcome: 'applied',
          lastAppliedAt: at,
          count: event.count
        }
        break
      case 'unread.stale':
        target.unread = { ...target.unread, at, outcome: 'stale' }
        break
      case 'relay.session':
        target.session = {
          ...target.session,
          at,
          outcome: event.outcome,
          ...(event.outcome === 'success' ? { lastSuccessAt: at } : {}),
          ...(event.code ? { code: event.code } : {})
        }
        break
      case 'relay.refresh':
        target.refresh = {
          ...target.refresh,
          at,
          outcome: event.outcome,
          ...(event.outcome === 'success' ? { lastSuccessAt: at } : {}),
          ...(event.code ? { code: event.code } : {})
        }
        break
      case 'relay.bootstrap':
        if (account) {
          const target = accounts[account]
          target.bootstrap = {
            at,
            stage: event.stage,
            outcome: event.outcome,
            ...(event.code ? { code: event.code } : {})
          }
        }
        break
      case 'relay.closed':
        target.relay = { ...target.relay, closedAt: at }
        break
    }
  }

  return {
    record,
    forget(accountId: string): void {
      const alias = aliases.get(accountId)
      if (!alias) return
      aliases.delete(accountId)
      delete accounts[alias]
      for (const key of lastPersisted.keys()) {
        if (key.startsWith(`${alias}:`)) lastPersisted.delete(key)
      }
    },
    snapshot(): MainDiagnosticsSnapshot {
      return {
        events: events.map((event) => ({ ...event })),
        accounts: Object.fromEntries(
          Object.entries(accounts).map(([key, value]) => [
            key,
            Object.fromEntries(
              Object.entries(value).map(([section, fields]) => [
                section,
                fields ? { ...fields } : fields
              ])
            )
          ])
        ) as Record<string, AccountSnapshot>
      }
    }
  }
}
