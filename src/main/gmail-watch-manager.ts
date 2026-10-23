import { isAccountId } from './account-state'
import { GmailMetadataFailure } from './gmail-metadata'
import type { GmailMetadataFailureCode } from './gmail-metadata'

export type GmailWatchRenewalResult = {
  readonly accountId: string
  readonly status: 'renewed' | 'retry' | 'blocked' | 'cancelled' | 'deferred'
  readonly nextAttemptAt: number | null
}

export type GmailWatchManagerFailureCode =
  'invalid_account' | 'invalid_time' | 'unavailable' | 'disposed'

export class GmailWatchManagerFailure extends Error {
  constructor(readonly code: GmailWatchManagerFailureCode) {
    super('Gmail watch manager request failed')
    this.name = 'GmailWatchManagerFailure'
  }
}

export type GmailWatchManager = {
  connect: (accountId: string, now: number) => Promise<GmailWatchRenewalResult>
  retry: (accountId: string, now: number) => Promise<GmailWatchRenewalResult>
  runDue: (now: number) => Promise<readonly GmailWatchRenewalResult[]>
  pause: () => void
  resume: (now: number) => Promise<readonly GmailWatchRenewalResult[]>
  disconnect: (accountId: string) => void
  getNextDueAt: () => number | null
  dispose: () => void
}

export type GmailWatchManagerDependencies = {
  readonly accountExists: (accountId: string) => boolean
  readonly registerWatch: (
    accountId: string,
    signal: AbortSignal
  ) => Promise<{ readonly expiresAt: number }>
  readonly onDiagnostic?: (event: {
    readonly accountId: string
    readonly status: GmailWatchRenewalResult['status']
    readonly nextAttemptAt: number | null
    readonly expiresAt?: number
    readonly code?:
      | 'unauthorized'
      | 'forbidden'
      | 'invalid_response'
      | 'redirect_refused'
      | 'unavailable'
      | 'unknown'
  }) => void
}

type Entry = {
  nextAttemptAt: number
  failures: number
  blocked: boolean
  flight: Flight | null
  result: GmailWatchRenewalResult
}

type Flight = {
  readonly controller: AbortController
  readonly requestNow: number
  promise: Promise<GmailWatchRenewalResult>
}

const MAX_TIME = Number.MAX_SAFE_INTEGER - 86_400_000
const BACKOFF = [60_000, 120_000, 240_000, 480_000, 900_000] as const
const BLOCKING_FAILURES = new Set([
  'unauthorized',
  'forbidden',
  'invalid_response',
  'redirect_refused'
])
type BlockingFailureCode = Extract<
  GmailMetadataFailureCode,
  'unauthorized' | 'forbidden' | 'invalid_response' | 'redirect_refused'
>

function isBlockingFailureCode(code: GmailMetadataFailureCode): code is BlockingFailureCode {
  return BLOCKING_FAILURES.has(code)
}

function validTime(now: number): boolean {
  return Number.isSafeInteger(now) && now >= 0 && now <= MAX_TIME
}

function outcome(
  accountId: string,
  status: GmailWatchRenewalResult['status'],
  nextAttemptAt: number | null
): GmailWatchRenewalResult {
  return Object.freeze({ accountId, status, nextAttemptAt })
}

export function createGmailWatchManager(deps: GmailWatchManagerDependencies): GmailWatchManager {
  const entries = new Map<string, Entry>()
  let paused = false
  let disposed = false
  const report = (
    event: Parameters<NonNullable<GmailWatchManagerDependencies['onDiagnostic']>>[0]
  ): void => {
    try {
      deps.onDiagnostic?.(event)
    } catch {
      // Diagnostics cannot change watch renewal behavior.
    }
  }

  function assertAvailable(): void {
    if (disposed) throw new GmailWatchManagerFailure('disposed')
  }

  function assertAccount(accountId: string): void {
    if (!isAccountId(accountId)) throw new GmailWatchManagerFailure('invalid_account')
  }

  function assertTime(now: number): void {
    if (!validTime(now)) throw new GmailWatchManagerFailure('invalid_time')
  }

  function exists(accountId: string): boolean {
    try {
      return deps.accountExists(accountId)
    } catch {
      throw new GmailWatchManagerFailure('unavailable')
    }
  }

  function current(entry: Entry, flight: Flight): boolean {
    return (
      !disposed &&
      !paused &&
      entries.get(entry.result.accountId) === entry &&
      entry.flight === flight
    )
  }

  function cancelled(accountId: string): GmailWatchRenewalResult {
    return outcome(accountId, 'cancelled', null)
  }

  function detach(entry: Entry, preserveDueAt?: number): void {
    const flight = entry.flight
    if (!flight) return
    entry.flight = null
    if (preserveDueAt !== undefined) {
      entry.nextAttemptAt = preserveDueAt
      entry.result = outcome(entry.result.accountId, 'deferred', preserveDueAt)
    }
    flight.controller.abort()
  }

  function begin(accountId: string, entry: Entry, now: number): Promise<GmailWatchRenewalResult> {
    const controller = new AbortController()
    const flight: Flight = {
      controller,
      requestNow: now,
      promise: Promise.resolve(outcome(accountId, 'cancelled', null))
    }
    entry.flight = flight
    flight.promise = Promise.resolve().then(async () => {
      if (!current(entry, flight)) return cancelled(accountId)
      let active: boolean
      try {
        active = deps.accountExists(accountId)
      } catch {
        if (!current(entry, flight)) return cancelled(accountId)
        return scheduleRetry(accountId, entry, flight, now)
      }
      if (!current(entry, flight)) return cancelled(accountId)
      if (!active) {
        if (entries.get(accountId) === entry) entries.delete(accountId)
        entry.flight = null
        return outcome(accountId, 'cancelled', null)
      }

      try {
        const lease = await deps.registerWatch(accountId, controller.signal)
        if (!current(entry, flight)) return cancelled(accountId)
        let stillActive: boolean
        try {
          stillActive = deps.accountExists(accountId)
        } catch {
          if (!current(entry, flight)) return cancelled(accountId)
          return scheduleRetry(accountId, entry, flight, now)
        }
        if (!current(entry, flight)) return cancelled(accountId)
        if (!stillActive) {
          entries.delete(accountId)
          entry.flight = null
          return outcome(accountId, 'cancelled', null)
        }
        if (
          typeof lease !== 'object' ||
          lease === null ||
          !Number.isSafeInteger(lease.expiresAt) ||
          lease.expiresAt <= now
        ) {
          return scheduleBlocked(accountId, entry, flight, 'invalid_response')
        }
        const delay = Math.min(86_400_000, Math.max(1, Math.floor((lease.expiresAt - now) / 2)))
        const nextAttemptAt = now + delay
        entry.failures = 0
        entry.blocked = false
        entry.nextAttemptAt = nextAttemptAt
        entry.flight = null
        entry.result = outcome(accountId, 'renewed', nextAttemptAt)
        report({ accountId, status: 'renewed', nextAttemptAt, expiresAt: lease.expiresAt })
        return entry.result
      } catch (error) {
        if (!current(entry, flight)) return cancelled(accountId)
        let stillActive: boolean
        try {
          stillActive = deps.accountExists(accountId)
        } catch {
          if (!current(entry, flight)) return cancelled(accountId)
          return scheduleRetry(accountId, entry, flight, now)
        }
        if (!current(entry, flight)) return cancelled(accountId)
        if (!stillActive) {
          entries.delete(accountId)
          entry.flight = null
          return outcome(accountId, 'cancelled', null)
        }
        if (error instanceof GmailMetadataFailure && isBlockingFailureCode(error.code)) {
          return scheduleBlocked(accountId, entry, flight, error.code)
        }
        return scheduleRetry(accountId, entry, flight, now)
      }
    })
    return flight.promise
  }

  function scheduleRetry(
    accountId: string,
    entry: Entry,
    flight: Flight,
    now: number
  ): GmailWatchRenewalResult {
    if (!current(entry, flight)) return cancelled(accountId)
    entry.failures += 1
    const delay = BACKOFF[Math.min(entry.failures - 1, BACKOFF.length - 1)]
    const nextAttemptAt = now + delay
    entry.blocked = false
    entry.nextAttemptAt = nextAttemptAt
    entry.flight = null
    entry.result = outcome(accountId, 'retry', nextAttemptAt)
    report({ accountId, status: 'retry', nextAttemptAt, code: 'unavailable' })
    return entry.result
  }

  function scheduleBlocked(
    accountId: string,
    entry: Entry,
    flight: Flight,
    code: BlockingFailureCode
  ): GmailWatchRenewalResult {
    if (!current(entry, flight)) return cancelled(accountId)
    entry.blocked = true
    entry.nextAttemptAt = Number.MAX_SAFE_INTEGER
    entry.flight = null
    entry.result = outcome(accountId, 'blocked', null)
    report({ accountId, status: 'blocked', nextAttemptAt: null, code })
    return entry.result
  }

  async function connect(accountId: string, now: number): Promise<GmailWatchRenewalResult> {
    assertAvailable()
    assertAccount(accountId)
    assertTime(now)
    let entry = entries.get(accountId)
    if (entry?.flight) return entry.flight.promise
    if (!exists(accountId)) throw new GmailWatchManagerFailure('invalid_account')
    if (!entry) {
      entry = {
        nextAttemptAt: now,
        failures: 0,
        blocked: false,
        flight: null,
        result: outcome(accountId, 'deferred', now)
      }
      entries.set(accountId, entry)
    }
    if (entry.blocked) return entry.result
    if (entry.failures > 0 && now < entry.nextAttemptAt) return entry.result
    if (paused) {
      entry.nextAttemptAt = Math.min(entry.nextAttemptAt, now)
      entry.result = outcome(accountId, 'deferred', entry.nextAttemptAt)
      return entry.result
    }
    return begin(accountId, entry, now)
  }

  async function retry(accountId: string, now: number): Promise<GmailWatchRenewalResult> {
    assertAvailable()
    assertAccount(accountId)
    assertTime(now)
    const entry = entries.get(accountId)
    if (!entry) return connect(accountId, now)
    if (entry.flight) return entry.flight.promise
    if (!exists(accountId)) throw new GmailWatchManagerFailure('invalid_account')
    entry.blocked = false
    entry.failures = 0
    entry.nextAttemptAt = now
    if (paused) {
      entry.result = outcome(accountId, 'deferred', now)
      return entry.result
    }
    return begin(accountId, entry, now)
  }

  async function runDue(now: number): Promise<readonly GmailWatchRenewalResult[]> {
    assertAvailable()
    assertTime(now)
    if (paused) return []
    const due: Array<[string, Entry]> = []
    for (const [accountId, entry] of entries) {
      if (!exists(accountId)) {
        entries.delete(accountId)
        detach(entry)
        continue
      }
      if (entry.flight || entry.blocked || entry.nextAttemptAt > now) continue
      due.push([accountId, entry])
    }
    return Promise.all(due.map(([accountId, entry]) => begin(accountId, entry, now)))
  }

  function pause(): void {
    if (disposed || paused) return
    paused = true
    for (const entry of entries.values()) detach(entry, entry.flight?.requestNow)
  }

  async function resume(now: number): Promise<readonly GmailWatchRenewalResult[]> {
    assertAvailable()
    assertTime(now)
    paused = false
    return runDue(now)
  }

  function disconnect(accountId: string): void {
    assertAccount(accountId)
    const entry = entries.get(accountId)
    if (!entry) return
    entries.delete(accountId)
    detach(entry)
  }

  function getNextDueAt(): number | null {
    if (paused || disposed) return null
    let next: number | null = null
    for (const entry of entries.values()) {
      if (entry.blocked || entry.flight) continue
      if (next === null || entry.nextAttemptAt < next) next = entry.nextAttemptAt
    }
    return next
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    for (const entry of entries.values()) detach(entry)
    entries.clear()
    paused = true
  }

  return { connect, retry, runDue, pause, resume, disconnect, getNextDueAt, dispose }
}
