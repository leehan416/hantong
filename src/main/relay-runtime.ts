import { RelayFailure } from './relay-client'
import type { RelaySignal } from './relay-client'

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
    signal?: AbortSignal
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
  // Absent → sessions live only until expiry, as with a relay that issues no refresh tokens.
  readonly credentials?: RelayCredentials
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
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
const PERMANENT_REFRESH_FAILURES = new Set(['unauthorized', 'invalid_response', 'redirect_refused'])

export function createRelayRuntime(dependencies: RelayRuntimeDependencies): {
  accept(accountId: string, proof: { readonly idToken?: string; readonly nonce?: string }): void
  resume(accountId: string): Promise<void>
  disconnect(accountId: string): void
  dispose(): Promise<void>
} {
  const owned = new Map<string, Operation>()
  const schedule = dependencies.setTimeout ?? setTimeout
  const unschedule = dependencies.clearTimeout ?? clearTimeout
  // Serialize per-account credential I/O so a late write cannot resurrect a deleted token.
  const credentialQueue = new Map<string, Promise<void>>()
  const credentialOp = (
    accountId: string,
    op: (store: RelayCredentials) => Promise<void>
  ): void => {
    const store = dependencies.credentials
    if (!store) return
    const next = (credentialQueue.get(accountId) ?? Promise.resolve())
      .then(() => op(store))
      .catch(() => undefined)
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
  const invalidate = (accountId: string, expected?: Operation, signOut = true): void => {
    const operation = owned.get(accountId)
    if (!operation || (expected && operation !== expected)) return
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
      if (!refresh) return
      if (error instanceof RelayFailure && PERMANENT_REFRESH_FAILURES.has(error.code)) {
        credentialOp(accountId, (store) => store.delete(accountId))
      } else if (dependencies.accountExists(accountId)) {
        retryRefresh(accountId, refresh.refreshToken, refresh.attempt + 1)
      }
      return
    }
    if (!current(accountId, operation)) {
      // A newer login or renewal owns the installation now; logging out would revoke its refresh.
      if (!owned.has(accountId)) logout(session.accessToken)
      return
    }
    if (session.expiresAt <= dependencies.now()) {
      invalidate(accountId, operation)
      return
    }
    operation.token = session.accessToken
    operation.expiresAt = session.expiresAt
    const refreshToken = session.refreshToken
    if (refreshToken) {
      operation.refreshToken = refreshToken
      credentialOp(accountId, (store) => store.write(accountId, refreshToken))
      operation.expiryTimer = schedule(
        () => renew(accountId, operation),
        Math.max(0, session.expiresAt - RENEW_LEAD_MS - dependencies.now())
      )
    } else {
      operation.expiryTimer = schedule(
        () => invalidate(accountId, operation),
        Math.max(0, session.expiresAt - dependencies.now())
      )
    }
    let delay = 1000
    const stream = async (): Promise<void> => {
      if (!current(accountId, operation) || !operation.token || !operation.expiresAt) return
      if (dependencies.now() >= operation.expiresAt) return
      let ready = false
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
          operation.controller.signal
        )
      } catch (error) {
        if (
          error instanceof RelayFailure &&
          error.code === 'unauthorized' &&
          operation.refreshToken
        ) {
          // The relay dropped the session early; refresh after a pause so a 401 loop stays slow.
          renew(accountId, operation, 1)
          return
        }
        if (
          error instanceof RelayFailure &&
          (error.code === 'unauthorized' ||
            error.code === 'invalid_response' ||
            error.code === 'redirect_refused')
        ) {
          invalidate(accountId, operation)
          return
        }
        if (operation.controller.signal.aborted) return
      }
      if (!current(accountId, operation)) return
      if (dependencies.now() >= (operation.expiresAt ?? 0)) return
      if (ready) delay = 1000
      const wait = Math.min(delay, Math.max(0, (operation.expiresAt ?? 0) - dependencies.now()))
      operation.timer = schedule(() => {
        operation.timer = undefined
        void stream().catch(() => invalidate(accountId, operation))
      }, wait)
      delay = Math.min(delay * 2, 30_000)
    }
    void stream().catch(() => invalidate(accountId, operation))
  }

  const refreshTokenFor = async (accountId: string): Promise<string | null> => {
    const store = dependencies.credentials
    if (!store) return null
    await credentialQueue.get(accountId)
    try {
      return await store.read(accountId)
    } catch {
      return null
    }
  }

  return {
    accept(accountId, proof): void {
      // The relay replaces this installation's session on login, so no logout is sent here.
      invalidate(accountId, undefined, false)
      const { idToken, nonce } = proof
      if (!idToken || !nonce || !dependencies.accountExists(accountId)) return
      start(accountId, (signal) =>
        dependencies.client.createSession(idToken, nonce, accountId, signal)
      )
    },
    async resume(accountId): Promise<void> {
      if (owned.has(accountId) || !dependencies.accountExists(accountId)) return
      const refreshToken = await refreshTokenFor(accountId)
      if (!refreshToken || owned.has(accountId) || !dependencies.accountExists(accountId)) return
      startRefresh(accountId, refreshToken)
    },
    disconnect(accountId): void {
      invalidate(accountId)
      credentialOp(accountId, (store) => store.delete(accountId))
    },
    async dispose(): Promise<void> {
      // Quitting keeps the server session and refresh token so the next launch can resume.
      for (const [accountId, operation] of owned) {
        owned.delete(accountId)
        retire(operation)
      }
      await Promise.all(credentialQueue.values())
    }
  }
}
