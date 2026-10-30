import { isAccountId } from './account-state'
import type { GoogleConnectionResult } from './google-connection'
import type { GoogleOAuthConfig } from './google-oauth-config'
import type { GoogleOAuthTokens } from './google-token-exchange'
import type { GoogleProtectedCredential } from './google-credential-store'

export interface GoogleConnectionManagerDependencies {
  readonly credentialStore: {
    read(accountId: string): Promise<GoogleProtectedCredential | null>
    write(accountId: string, credential: GoogleProtectedCredential): Promise<void>
    delete(accountId: string): Promise<void>
  }
  readonly now: () => number
  readonly refreshTokens: (
    config: GoogleOAuthConfig,
    refreshToken: string,
    signal: AbortSignal
  ) => Promise<GoogleOAuthTokens>
}

export class GoogleConnectionManagerFailure extends Error {
  constructor(
    readonly code: 'disconnected' | 'reconnect_required' | 'invalid_connection' | 'unavailable'
  ) {
    super(`Google API connection ${code.replaceAll('_', ' ')}`)
    this.name = 'GoogleConnectionManagerFailure'
  }
}

interface ConnectionState {
  readonly emailAddress: string
  readonly refreshToken: string
  readonly accessToken: string
  readonly expiresAt: number
}

type PublicStatus =
  | { readonly status: 'disconnected' }
  | { readonly status: 'connected'; readonly emailAddress: string }
  | { readonly status: 'reconnect_required'; readonly emailAddress: string }

export function createGoogleConnectionManager(dependencies: GoogleConnectionManagerDependencies): {
  acceptConnection(accountId: string, result: GoogleConnectionResult): Promise<PublicStatus>
  getAccessToken(accountId: string, config: GoogleOAuthConfig): Promise<string>
  getStatus(accountId: string): Promise<PublicStatus>
  getGeneration(accountId: string): number
  disconnect(accountId: string): Promise<void>
} {
  const connections = new Map<string, ConnectionState>()
  const reconnectRequired = new Map<string, string>()
  const blocked = new Set<string>()
  const generations = new Map<string, number>()
  const refreshes = new Map<string, { promise: Promise<string>; controller: AbortController }>()
  const queues = new Map<string, Promise<unknown>>()

  const generation = (accountId: string): number => generations.get(accountId) ?? 0
  const advance = (accountId: string): number => {
    const next = generation(accountId) + 1
    generations.set(accountId, next)
    refreshes.get(accountId)?.controller.abort()
    refreshes.delete(accountId)
    return next
  }
  const requireAccount = (accountId: string): void => {
    if (!isAccountId(accountId)) throw new GoogleConnectionManagerFailure('unavailable')
  }
  const serialized = <T>(accountId: string, action: () => Promise<T>): Promise<T> => {
    const previous = queues.get(accountId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(action)
    queues.set(accountId, current)
    void current
      .finally(() => {
        if (queues.get(accountId) === current) queues.delete(accountId)
      })
      .catch(() => undefined)
    return current
  }
  const isCurrent = (accountId: string, expected: number): boolean =>
    generation(accountId) === expected

  const refresh = (accountId: string, config: GoogleOAuthConfig): Promise<string> => {
    const existing = refreshes.get(accountId)
    if (existing) return existing.promise
    const expectedGeneration = generation(accountId)
    const controller = new AbortController()
    const promise = (async (): Promise<string> => {
      let current = connections.get(accountId)
      if (!current) {
        let stored: GoogleProtectedCredential | null
        try {
          stored = await serialized(accountId, () => dependencies.credentialStore.read(accountId))
        } catch {
          throw new GoogleConnectionManagerFailure('unavailable')
        }
        if (!isCurrent(accountId, expectedGeneration))
          throw new GoogleConnectionManagerFailure('disconnected')
        if (!stored) throw new GoogleConnectionManagerFailure('disconnected')
        current = {
          emailAddress: stored.emailAddress,
          refreshToken: stored.refreshToken,
          accessToken: '',
          expiresAt: 0
        }
        connections.set(accountId, current)
      }
      if (reconnectRequired.has(accountId))
        throw new GoogleConnectionManagerFailure('reconnect_required')
      let refreshed: GoogleOAuthTokens
      try {
        refreshed = await dependencies.refreshTokens(
          config,
          current.refreshToken,
          controller.signal
        )
      } catch (error) {
        if (!isCurrent(accountId, expectedGeneration))
          throw new GoogleConnectionManagerFailure('disconnected')
        if (isRecord(error) && error.code === 'invalid_grant') {
          advance(accountId)
          reconnectRequired.set(accountId, current.emailAddress)
          connections.delete(accountId)
          throw new GoogleConnectionManagerFailure('reconnect_required')
        }
        if (controller.signal.aborted) throw new GoogleConnectionManagerFailure('disconnected')
        throw new GoogleConnectionManagerFailure('unavailable')
      }
      if (!isCurrent(accountId, expectedGeneration))
        throw new GoogleConnectionManagerFailure('disconnected')
      let refreshedAt: number
      try {
        refreshedAt = dependencies.now()
      } catch {
        throw new GoogleConnectionManagerFailure('unavailable')
      }
      if (
        !refreshed.accessToken.trim() ||
        !Number.isFinite(refreshed.expiresAt) ||
        !Number.isFinite(refreshedAt) ||
        refreshed.expiresAt <= refreshedAt
      ) {
        throw new GoogleConnectionManagerFailure('unavailable')
      }
      const nextRefreshToken = refreshed.refreshToken ?? current.refreshToken
      const next = {
        ...current,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshToken: nextRefreshToken
      }
      if (refreshed.refreshToken) {
        const rotatedRefreshToken = refreshed.refreshToken
        try {
          await serialized(accountId, async () => {
            if (!isCurrent(accountId, expectedGeneration))
              throw new GoogleConnectionManagerFailure('disconnected')
            await dependencies.credentialStore.write(accountId, {
              refreshToken: rotatedRefreshToken,
              emailAddress: current.emailAddress
            })
          })
        } catch (error) {
          if (error instanceof GoogleConnectionManagerFailure) throw error
          throw new GoogleConnectionManagerFailure('unavailable')
        }
      }
      if (!isCurrent(accountId, expectedGeneration))
        throw new GoogleConnectionManagerFailure('disconnected')
      connections.set(accountId, next)
      return next.accessToken
    })()
    refreshes.set(accountId, { promise, controller })
    void promise
      .finally(() => {
        if (refreshes.get(accountId)?.promise === promise) refreshes.delete(accountId)
      })
      .catch(() => undefined)
    return promise
  }

  return {
    async acceptConnection(accountId, result): Promise<PublicStatus> {
      requireAccount(accountId)
      const emailAddress = result?.emailAddress?.trim()
      const tokens = result?.tokens
      if (
        !emailAddress ||
        !/^[^\s@]+@[^\s@]+$/.test(emailAddress) ||
        !tokens?.accessToken?.trim() ||
        !tokens.refreshToken?.trim() ||
        !Number.isFinite(tokens.expiresAt)
      ) {
        throw new GoogleConnectionManagerFailure('invalid_connection')
      }
      const expectedGeneration = advance(accountId)
      connections.delete(accountId)
      reconnectRequired.delete(accountId)
      blocked.add(accountId)
      const refreshToken = tokens.refreshToken
      return serialized(accountId, async () => {
        if (!isCurrent(accountId, expectedGeneration))
          throw new GoogleConnectionManagerFailure('disconnected')
        try {
          await dependencies.credentialStore.write(accountId, {
            refreshToken,
            emailAddress
          })
        } catch {
          throw new GoogleConnectionManagerFailure('unavailable')
        }
        if (!isCurrent(accountId, expectedGeneration))
          throw new GoogleConnectionManagerFailure('disconnected')
        reconnectRequired.delete(accountId)
        blocked.delete(accountId)
        connections.set(accountId, {
          emailAddress,
          refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt
        })
        return { status: 'connected', emailAddress }
      })
    },
    async getAccessToken(accountId, config): Promise<string> {
      requireAccount(accountId)
      if (blocked.has(accountId)) throw new GoogleConnectionManagerFailure('disconnected')
      const reconnectEmail = reconnectRequired.get(accountId)
      if (reconnectEmail) throw new GoogleConnectionManagerFailure('reconnect_required')
      const current = connections.get(accountId)
      let now: number
      try {
        now = dependencies.now()
      } catch {
        throw new GoogleConnectionManagerFailure('unavailable')
      }
      if (current?.accessToken && current.expiresAt > now + 60_000) return current.accessToken
      return refresh(accountId, config)
    },
    async getStatus(accountId): Promise<PublicStatus> {
      requireAccount(accountId)
      if (blocked.has(accountId)) return { status: 'disconnected' }
      const emailAddress = reconnectRequired.get(accountId)
      if (emailAddress) return { status: 'reconnect_required', emailAddress }
      const current = connections.get(accountId)
      if (current) return { status: 'connected', emailAddress: current.emailAddress }
      const expectedGeneration = generation(accountId)
      let stored: GoogleProtectedCredential | null
      try {
        stored = await serialized(accountId, () => dependencies.credentialStore.read(accountId))
      } catch {
        throw new GoogleConnectionManagerFailure('unavailable')
      }
      if (!isCurrent(accountId, expectedGeneration))
        throw new GoogleConnectionManagerFailure('disconnected')
      if (blocked.has(accountId)) return { status: 'disconnected' }
      const reconnectEmail = reconnectRequired.get(accountId)
      if (reconnectEmail) return { status: 'reconnect_required', emailAddress: reconnectEmail }
      const latest = connections.get(accountId)
      if (latest) return { status: 'connected', emailAddress: latest.emailAddress }
      if (!stored) return { status: 'disconnected' }
      return { status: 'connected', emailAddress: stored.emailAddress }
    },
    getGeneration(accountId): number {
      requireAccount(accountId)
      return generation(accountId)
    },
    async disconnect(accountId): Promise<void> {
      requireAccount(accountId)
      const expectedGeneration = advance(accountId)
      connections.delete(accountId)
      reconnectRequired.delete(accountId)
      blocked.add(accountId)
      // Local disconnect intentionally avoids Google's grant-wide revoke endpoint, which can affect other clients.
      await serialized(accountId, async () => {
        if (!isCurrent(accountId, expectedGeneration)) return
        try {
          await dependencies.credentialStore.delete(accountId)
        } catch {
          throw new GoogleConnectionManagerFailure('unavailable')
        }
      })
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
