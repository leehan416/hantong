import type { MainDiagnosticEvent, RelayDiagnosticCode } from './main-diagnostics-types'

export function relayDiagnosticCode(value: unknown): RelayDiagnosticCode {
  return typeof value === 'string' &&
    [
      'cancelled',
      'timeout',
      'network_error',
      'unauthorized',
      'rate_limited',
      'unavailable',
      'invalid_response',
      'redirect_refused',
      'unknown'
    ].includes(value)
    ? (value as RelayDiagnosticCode)
    : 'unknown'
}

export function safeCode(code: RelayDiagnosticCode): RelayDiagnosticCode {
  const allowed: readonly string[] = [
    'cancelled',
    'timeout',
    'network_error',
    'unauthorized',
    'rate_limited',
    'unavailable',
    'invalid_response',
    'redirect_refused',
    'unknown'
  ]
  return allowed.includes(code) ? code : 'unknown'
}

export function safeOutcome(value: unknown): 'success' | 'failure' | 'retry' | 'blocked' {
  return value === 'success' || value === 'failure' || value === 'retry' || value === 'blocked'
    ? value
    : 'failure'
}

export function isEvent(value: unknown): value is MainDiagnosticEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const event = value as {
    type?: unknown
    accountId?: unknown
    code?: unknown
    outcome?: unknown
    kind?: unknown
    expiresAt?: unknown
    nextAttemptAt?: unknown
    count?: unknown
    delayMs?: unknown
    stage?: unknown
  }
  const types: readonly string[] = [
    'relay.ready',
    'relay.receive',
    'relay.heartbeat',
    'relay.closed',
    'relay.failure',
    'relay.retry',
    'relay.session',
    'relay.refresh',
    'relay.bootstrap',
    'sync.success',
    'sync.null',
    'sync.failure',
    'watch.renewed',
    'watch.retry',
    'watch.blocked',
    'watch.cancelled',
    'unread.success',
    'unread.failure',
    'unread.applied',
    'unread.stale'
  ]
  if (typeof event.type !== 'string' || !types.includes(event.type)) return false
  if (
    event.type === 'relay.bootstrap' &&
    (typeof event.stage !== 'string' ||
      ![
        'config',
        'challenge',
        'proof',
        'proof_id_token',
        'proof_nonce',
        'credentials',
        'session_start',
        'stream_start',
        'credential_write'
      ].includes(event.stage) ||
      typeof event.outcome !== 'string' ||
      ![
        'enabled',
        'disabled',
        'invalid',
        'started',
        'missing',
        'unavailable',
        'success',
        'failure',
        'skipped'
      ].includes(event.outcome))
  )
    return false
  if (event.type === 'relay.bootstrap') {
    if (
      event.accountId !== undefined &&
      (typeof event.accountId !== 'string' ||
        event.accountId.length === 0 ||
        event.accountId.length > 256)
    )
      return false
  } else if (
    !('accountId' in event) ||
    typeof event.accountId !== 'string' ||
    event.accountId.length === 0 ||
    event.accountId.length > 256
  )
    return false
  if (
    (event.type === 'relay.failure' ||
      event.type === 'relay.retry' ||
      event.type === 'relay.session' ||
      event.type === 'relay.refresh') &&
    event.code !== undefined &&
    (typeof event.code !== 'string' ||
      ![
        'cancelled',
        'timeout',
        'network_error',
        'unauthorized',
        'rate_limited',
        'unavailable',
        'invalid_response',
        'redirect_refused',
        'unknown'
      ].includes(event.code))
  )
    return false
  if (
    event.type === 'relay.bootstrap' &&
    event.code !== undefined &&
    (typeof event.code !== 'string' ||
      ![
        'cancelled',
        'timeout',
        'network_error',
        'unauthorized',
        'rate_limited',
        'unavailable',
        'invalid_response',
        'redirect_refused',
        'unknown'
      ].includes(event.code))
  )
    return false
  if (
    (event.type === 'relay.session' || event.type === 'relay.refresh') &&
    event.outcome !== undefined &&
    (typeof event.outcome !== 'string' ||
      !['success', 'failure', 'retry', 'blocked'].includes(event.outcome))
  )
    return false
  if (event.type === 'sync.success' && event.kind !== 'baseline' && event.kind !== 'changes')
    return false
  if (
    event.type === 'watch.renewed' &&
    (!Number.isSafeInteger(event.expiresAt) || Number(event.expiresAt) < 0)
  )
    return false
  if (
    ['watch.retry', 'watch.blocked', 'watch.cancelled'].includes(String(event.type)) &&
    event.nextAttemptAt !== null &&
    (!Number.isSafeInteger(event.nextAttemptAt) || Number(event.nextAttemptAt) < 0)
  )
    return false
  if (
    event.type === 'relay.retry' &&
    (!Number.isSafeInteger(event.delayMs) || Number(event.delayMs) < 0)
  )
    return false
  if (
    event.type === 'unread.applied' &&
    (!Number.isSafeInteger(event.count) || Number(event.count) < 0)
  )
    return false
  if (
    event.type === 'relay.retry' &&
    (!Number.isSafeInteger(event.delayMs) || Number(event.delayMs) < 0)
  )
    return false
  if (
    ['watch.retry', 'watch.blocked', 'watch.cancelled'].includes(event.type as string) &&
    event.nextAttemptAt !== null &&
    !Number.isSafeInteger(event.nextAttemptAt)
  )
    return false
  return true
}
