import { RelayFailure } from './relay-client'
import type { RelaySignal } from './relay-client'
import type { RelayTransportEvent } from './relay-client'

interface RelaySession {
  readonly accessToken: string
  readonly expiresAt: number
  readonly refreshToken?: string
}

interface RelayClient {
  createSession(
    idToken: string,
    nonce: string,
    installationId: string,
    signal?: AbortSignal
  ): Promise<RelaySession>
  refreshSession(refreshToken: string, signal?: AbortSignal): Promise<RelaySession>
  deleteSession(token: string): Promise<void>
  consumeEvents(
    token: string,
    onEvent: (event: RelaySignal) => void,
    signal?: AbortSignal,
    observe?: (event: RelayTransportEvent) => void
  ): Promise<void>
}

interface RelayCredentials {
  read(accountId: string): Promise<string | null>
  write(accountId: string, refreshToken: string): Promise<void>
  delete(accountId: string): Promise<void>
}

interface RelayRuntimeDependencies {
  readonly client: RelayClient
  readonly accountExists: (accountId: string) => boolean
  readonly now: () => number
  readonly onSignal: (accountId: string, event: RelaySignal) => void
  readonly onDiagnostic?: (
    event:
      | {
          readonly type: 'session' | 'refresh'
          readonly accountId: string
          readonly outcome: 'success' | 'failure' | 'retry' | 'blocked'
          readonly code?: string
        }
      | {
          readonly type: 'transport'
          readonly accountId: string
          readonly transport?: RelayTransportEvent
          readonly code?: string
        }
      | {
          readonly type: 'reconnect'
          readonly accountId: string
          readonly outcome: 'retry' | 'blocked'
          readonly code?: string
          readonly delayMs?: number
        }
      | {
          readonly type: 'bootstrap'
          readonly accountId: string
          readonly stage:
            | 'proof_id_token'
            | 'proof_nonce'
            | 'credentials'
            | 'session_start'
            | 'stream_start'
            | 'credential_write'
          readonly outcome:
            'started' | 'missing' | 'unavailable' | 'success' | 'failure' | 'skipped'
          readonly code?: string
        }
  ) => void
  // Absent → sessions live only until expiry, as with a relay that issues no refresh tokens.
  readonly credentials?: RelayCredentials
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly random?: () => number
}

interface Operation {
  readonly controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  token?: string
  expiresAt?: number
  refreshToken?: string
  stopped: boolean
}

type Obtain = (signal: AbortSignal) => Promise<RelaySession>
type RefreshAttempt = { readonly refreshToken: string; readonly attempt: number }

// Renew this long before the server session ends so the stream never sees the expiry.
const RENEW_LEAD_MS = 60_000
const REFRESH_RETRY_MS = 60_000
const MAX_REFRESH_RETRY_MS = 15 * 60_000
// The refresh token itself is dead (revoked, replayed, expired or relay lost its state).
const PERMANENT_REFRESH_FAILURES = new Set(['unauthorized'])

export function createRelayRuntime(dependencies: RelayRuntimeDependencies): {
  accept(accountId: string, proof: { readonly idToken?: string; readonly nonce?: string }): void
  resume(accountId: string): Promise<void>
  reconnect(accountId: string): Promise<void>
  disconnect(accountId: string): void
  dispose(): Promise<void>
} {
  const owned = new Map<string, Operation>()
  const diagnosticEpochs = new Map<string, { epoch: number; pending: number }>()
  let disposed = false
  const diagnosticEpoch = (accountId: string): number => diagnosticEpochs.get(accountId)?.epoch ?? 0
  const beginDiagnosticWork = (accountId: string): number => {
    const state = diagnosticEpochs.get(accountId) ?? { epoch: 0, pending: 0 }
    state.pending += 1
    diagnosticEpochs.set(accountId, state)
    return state.epoch
  }
  const finishDiagnosticWork = (accountId: string): void => {
    const state = diagnosticEpochs.get(accountId)
    if (!state) return
    state.pending -= 1
    if (state.pending === 0) diagnosticEpochs.delete(accountId)
  }
  const advanceDiagnosticEpoch = (accountId: string): number => {
    const state = diagnosticEpochs.get(accountId)
    if (!state) return 0
    state.epoch += 1
    return state.epoch
  }
  const isCurrentDiagnosticEpoch = (accountId: string, epoch: number): boolean =>
    !disposed && diagnosticEpochs.get(accountId)?.epoch === epoch
  const diagnostic = (
    event: Parameters<NonNullable<RelayRuntimeDependencies['onDiagnostic']>>[0]
  ): void => {
    try {
      dependencies.onDiagnostic?.(event)
    } catch {
      // Diagnostics are advisory and cannot interrupt relay lifecycle work.
    }
  }
  const bootstrap = (
    accountId: string,
    stage:
      | 'proof_id_token'
      | 'proof_nonce'
      | 'credentials'
      | 'session_start'
      | 'stream_start'
      | 'credential_write',
    outcome: 'started' | 'missing' | 'unavailable' | 'success' | 'failure' | 'skipped',
    code?: string
  ): void => diagnostic({ type: 'bootstrap', accountId, stage, outcome, code })
  const schedule = dependencies.setTimeout ?? setTimeout
  const unschedule = dependencies.clearTimeout ?? clearTimeout
  // Serialize per-account credential I/O so a late write cannot resurrect a deleted token.
  const credentialQueue = new Map<string, Promise<void>>()
  const credentialOp = (
    accountId: string,
    stage: 'credential_write' | 'credential_delete',
    op: (store: RelayCredentials) => Promise<void>
  ): void => {
    const store = dependencies.credentials
    if (!store) return
    const expectedDiagnosticEpoch =
      stage === 'credential_write' ? beginDiagnosticWork(accountId) : undefined
    const next = (credentialQueue.get(accountId) ?? Promise.resolve())
      .then(() => op(store))
      .then(() => {
        if (
          stage === 'credential_write' &&
          expectedDiagnosticEpoch !== undefined &&
          isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch)
        )
          bootstrap(accountId, 'credential_write', 'success')
      })
      .catch(() => {
        if (
          stage === 'credential_write' &&
          expectedDiagnosticEpoch !== undefined &&
          isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch)
        )
          bootstrap(accountId, 'credential_write', 'failure', 'unavailable')
      })
      .finally(() => {
        if (expectedDiagnosticEpoch !== undefined) finishDiagnosticWork(accountId)
      })
    credentialQueue.set(accountId, next)
    void next.finally(() => {
      if (credentialQueue.get(accountId) === next) credentialQueue.delete(accountId)
    })
  }
  // Logout also revokes the relay refresh token, so only an explicit disconnect may send it.
  const logout = (token: string | undefined): void => {
    if (token) void dependencies.client.deleteSession(token).catch(() => undefined)
  }
  const retire = (operation: Operation): string | undefined => {
    operation.stopped = true
    operation.controller.abort()
    if (operation.timer) unschedule(operation.timer)
    if (operation.expiryTimer) unschedule(operation.expiryTimer)
    const token = operation.token
    operation.token = undefined
    operation.expiresAt = undefined
    operation.refreshToken = undefined
    operation.timer = undefined
    operation.expiryTimer = undefined
    return token
  }
  const invalidate = (accountId: string, expected?: Operation, signOut = false): void => {
    const operation = owned.get(accountId)
    if (!operation || (expected && operation !== expected)) return
    advanceDiagnosticEpoch(accountId)
    owned.delete(accountId)
    const token = retire(operation)
    if (signOut) logout(token)
  }
  const current = (accountId: string, operation: Operation): boolean =>
    owned.get(accountId) === operation &&
    !operation.stopped &&
    !operation.controller.signal.aborted &&
    dependencies.accountExists(accountId)

  const start = (accountId: string, obtain: Obtain, refresh?: RefreshAttempt): void => {
    const operation: Operation = { controller: new AbortController(), stopped: false }
    owned.set(accountId, operation)
    void run(accountId, operation, obtain, refresh).catch(() => invalidate(accountId, operation))
  }
  const startRefresh = (accountId: string, refreshToken: string, attempt = 0): void =>
    start(accountId, (signal) => dependencies.client.refreshSession(refreshToken, signal), {
      refreshToken,
      attempt
    })
  // Holds the account slot while waiting, so disconnect or a new login cancels the retry.
  const retryRefresh = (accountId: string, refreshToken: string, attempt: number): void => {
    const waiting: Operation = { controller: new AbortController(), stopped: false }
    owned.set(accountId, waiting)
    waiting.timer = schedule(
      () => {
        if (owned.get(accountId) !== waiting) return
        owned.delete(accountId)
        startRefresh(accountId, refreshToken, attempt)
      },
      Math.min(REFRESH_RETRY_MS * 2 ** Math.max(0, attempt - 1), MAX_REFRESH_RETRY_MS)
    )
  }
  const renew = (accountId: string, operation: Operation, attempt = 0): void => {
    const refreshToken = operation.refreshToken
    if (!refreshToken || owned.get(accountId) !== operation) return
    // The relay revokes the old session itself when it rotates the refresh token.
    invalidate(accountId, operation, false)
    if (attempt) retryRefresh(accountId, refreshToken, attempt)
    else startRefresh(accountId, refreshToken)
  }

  const run = async (
    accountId: string,
    operation: Operation,
    obtain: Obtain,
    refresh?: RefreshAttempt
  ): Promise<void> => {
    let session: RelaySession
    try {
      session = await obtain(operation.controller.signal)
    } catch (error) {
      if (owned.get(accountId) !== operation) return
      owned.delete(accountId)
      retire(operation)
      if (!refresh) {
        diagnostic({ type: 'session', accountId, outcome: 'failure', code: safeRelayCode(error) })
        return
      }
      if (error instanceof RelayFailure && PERMANENT_REFRESH_FAILURES.has(error.code)) {
        diagnostic({ type: 'refresh', accountId, outcome: 'blocked', code: error.code })
        credentialOp(accountId, 'credential_delete', (store) => store.delete(accountId))
      } else if (dependencies.accountExists(accountId)) {
        diagnostic({ type: 'refresh', accountId, outcome: 'retry', code: safeRelayCode(error) })
        retryRefresh(accountId, refresh.refreshToken, refresh.attempt + 1)
      } else {
        diagnostic({ type: 'refresh', accountId, outcome: 'failure', code: safeRelayCode(error) })
      }
      return
    }
    if (!current(accountId, operation)) {
      // A newer login or renewal owns the installation now; logging out would revoke its refresh.
      if (!owned.has(accountId)) logout(session.accessToken)
      return
    }
    if (session.expiresAt <= dependencies.now()) {
      diagnostic({
        type: refresh ? 'refresh' : 'session',
        accountId,
        outcome: 'failure',
        code: 'invalid_response'
      })
      invalidate(accountId, operation, false)
      return
    }
    diagnostic({ type: refresh ? 'refresh' : 'session', accountId, outcome: 'success' })
    operation.token = session.accessToken
    operation.expiresAt = session.expiresAt
    const refreshToken = session.refreshToken
    if (refreshToken) {
      operation.refreshToken = refreshToken
      credentialOp(accountId, 'credential_write', (store) => store.write(accountId, refreshToken))
      operation.expiryTimer = schedule(
        () => renew(accountId, operation),
        Math.max(0, session.expiresAt - RENEW_LEAD_MS - dependencies.now())
      )
    } else {
      operation.expiryTimer = schedule(
        () => invalidate(accountId, operation, false),
        Math.max(0, session.expiresAt - dependencies.now())
      )
    }
    let delay = 1000
    const stream = async (): Promise<void> => {
      if (!current(accountId, operation) || !operation.token || !operation.expiresAt) return
      if (dependencies.now() >= operation.expiresAt) return
      bootstrap(accountId, 'stream_start', 'started')
      let ready = false
      let terminalCode = 'network_error'
      try {
        await dependencies.client.consumeEvents(
          operation.token,
          (event) => {
            if (!current(accountId, operation)) return
            if (event.type === 'ready') {
              ready = true
              delay = 1000
            }
            try {
              dependencies.onSignal(accountId, event)
            } catch {
              // The consumer is an advisory signal handler.
            }
          },
          operation.controller.signal,
          (transport) => {
            if (transport.type === 'failure') terminalCode = transport.code
            if (current(accountId, operation))
              diagnostic({ type: 'transport', accountId, transport })
          }
        )
        // A normally-ended stream is retried too; the observer reports the close separately.
      } catch (error) {
        terminalCode = safeRelayCode(error)
        if (
          current(accountId, operation) &&
          !(error instanceof RelayFailure && error.code === 'cancelled')
        ) {
          diagnostic({ type: 'transport', accountId, code: safeRelayCode(error) })
        }
        if (
          error instanceof RelayFailure &&
          error.code === 'unauthorized' &&
          operation.refreshToken
        ) {
          // The relay dropped the session early; refresh after a pause so a 401 loop stays slow.
          renew(accountId, operation, 1)
          return
        }
        if (error instanceof RelayFailure && error.code === 'unauthorized') {
          diagnostic({ type: 'reconnect', accountId, outcome: 'blocked', code: error.code })
          invalidate(accountId, operation, false)
          return
        }
        if (operation.controller.signal.aborted) return
      }
      if (!current(accountId, operation)) return
      if (dependencies.now() >= (operation.expiresAt ?? 0)) return
      if (ready) delay = 1000
      const random = dependencies.random?.() ?? Math.random()
      const jitter = 0.8 + Math.max(0, Math.min(1, random)) * 0.4
      const wait = Math.min(
        30_000,
        Math.round(delay * jitter),
        Math.max(0, (operation.expiresAt ?? 0) - dependencies.now())
      )
      operation.timer = schedule(() => {
        operation.timer = undefined
        void stream().catch(() => invalidate(accountId, operation, false))
      }, wait)
      diagnostic({
        type: 'reconnect',
        accountId,
        outcome: 'retry',
        code: terminalCode,
        delayMs: wait
      })
      delay = Math.min(delay * 2, 30_000)
    }
    void stream().catch(() => invalidate(accountId, operation, false))
  }

  const refreshTokenFor = async (accountId: string): Promise<string | null> => {
    const expectedDiagnosticEpoch = diagnosticEpoch(accountId)
    const store = dependencies.credentials
    if (!store) {
      bootstrap(accountId, 'credentials', 'unavailable', 'unavailable')
      return null
    }
    await credentialQueue.get(accountId)
    try {
      const value = await store.read(accountId)
      if (isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch))
        bootstrap(accountId, 'credentials', value ? 'success' : 'missing')
      return value
    } catch {
      if (isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch))
        bootstrap(accountId, 'credentials', 'failure', 'unavailable')
      return null
    }
  }

  const resume = async (accountId: string): Promise<void> => {
    if (disposed || owned.has(accountId) || !dependencies.accountExists(accountId)) return
    const expectedDiagnosticEpoch = beginDiagnosticWork(accountId)
    try {
      const refreshToken = await refreshTokenFor(accountId)
      if (!refreshToken || !isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch)) return
      if (owned.has(accountId) || !dependencies.accountExists(accountId)) {
        if (isCurrentDiagnosticEpoch(accountId, expectedDiagnosticEpoch))
          bootstrap(accountId, 'credentials', 'skipped')
        return
      }
      bootstrap(accountId, 'session_start', 'started')
      startRefresh(accountId, refreshToken)
    } finally {
      finishDiagnosticWork(accountId)
    }
  }

  return {
    accept(accountId, proof): void {
      // The relay replaces this installation's session on login, so no logout is sent here.
      invalidate(accountId, undefined, false)
      advanceDiagnosticEpoch(accountId)
      const { idToken, nonce } = proof
      if (!idToken || !nonce) {
        if (!idToken) bootstrap(accountId, 'proof_id_token', 'missing')
        if (!nonce) bootstrap(accountId, 'proof_nonce', 'missing')
        return
      }
      if (!dependencies.accountExists(accountId)) return
      bootstrap(accountId, 'session_start', 'started')
      start(accountId, (signal) =>
        dependencies.client.createSession(idToken, nonce, accountId, signal)
      )
    },
    resume,
    async reconnect(accountId): Promise<void> {
      if (disposed || !dependencies.accountExists(accountId)) return
      const operation = owned.get(accountId)
      if (operation) invalidate(accountId, operation, false)
      await resume(accountId)
    },
    disconnect(accountId): void {
      invalidate(accountId, undefined, true)
      advanceDiagnosticEpoch(accountId)
      credentialOp(accountId, 'credential_delete', (store) => store.delete(accountId))
    },
    async dispose(): Promise<void> {
      disposed = true
      for (const state of diagnosticEpochs.values()) state.epoch += 1
      // Quitting keeps the server session and refresh token so the next launch can resume.
      for (const [accountId, operation] of owned) {
        owned.delete(accountId)
        retire(operation)
      }
      await Promise.all(credentialQueue.values())
    }
  }
}

function safeRelayCode(error: unknown): string {
  return error instanceof RelayFailure
    ? error.code
    : error instanceof Error && error.name === 'AbortError'
      ? 'cancelled'
      : 'unknown'
}
