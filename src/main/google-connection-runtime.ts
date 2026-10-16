import type { GoogleAuthorizationOperation } from './google-authorization'
import type { GoogleConnectionStatus } from '../shared/ipc'
import { GoogleConnectionFailure, startGoogleConnection } from './google-connection'
import type { GoogleConnectionFailureCode, GoogleConnectionResult } from './google-connection'
import type { GoogleOAuthConfig } from './google-oauth-config'

export type GoogleConnectionStatusDto = GoogleConnectionStatus
type RuntimeDiagnosticCode =
  | Exclude<GoogleConnectionFailureCode, 'cancelled'>
  | 'config_unavailable'
  | 'connection_start_failed'
  | 'connection_failed'
  | 'accept_failed'

interface ConnectionManager {
  acceptConnection(accountId: string, result: GoogleConnectionResult): Promise<unknown>
  getStatus(
    accountId: string
  ): Promise<{ status: 'disconnected' | 'connected' | 'reconnect_required' }>
  disconnect(accountId: string): Promise<void>
}

interface RuntimeDependencies {
  readonly accountExists: (accountId: string) => boolean
  readonly readWebIdentity: (
    accountId: string,
    signal: AbortSignal
  ) => Promise<{
    readonly accountExists: boolean
    readonly emailAddress: string | null
  } | null>
  readonly loadConfig: () => GoogleOAuthConfig
  readonly startAuthorization: (config: GoogleOAuthConfig) => GoogleAuthorizationOperation
  readonly exchangeCode: Parameters<typeof startGoogleConnection>[2]['exchangeCode']
  readonly fetchProfile: Parameters<typeof startGoogleConnection>[2]['fetchProfile']
  readonly manager: ConnectionManager
  readonly reportFailure?: (
    stage: 'config' | 'connection' | 'persistence',
    code: RuntimeDiagnosticCode
  ) => void
}

interface ActiveOperation {
  readonly cancel: () => void
  phase: 'connecting' | 'accepting'
}

export function createGoogleConnectionRuntime(dependencies: RuntimeDependencies): {
  getStatus(accountId: string): Promise<GoogleConnectionStatusDto>
  connect(accountId: string): Promise<GoogleConnectionStatusDto>
  cancel(accountId: string): Promise<GoogleConnectionStatusDto>
  disconnect(accountId: string): Promise<GoogleConnectionStatusDto>
  cancelAll(): Promise<void>
} {
  const active = new Map<string, ActiveOperation>()
  const generations = new Map<string, number>()
  const generation = (id: string): number => generations.get(id) ?? 0
  const advance = (id: string): number => {
    const next = generation(id) + 1
    generations.set(id, next)
    return next
  }
  const status = (
    accountId: string,
    value: GoogleConnectionStatus['status']
  ): GoogleConnectionStatusDto => ({
    accountId,
    status: value
  })
  const reportFailure = (
    stage: 'config' | 'connection' | 'persistence',
    code: RuntimeDiagnosticCode
  ): void => {
    try {
      dependencies.reportFailure?.(stage, code)
    } catch {
      // Diagnostics must never affect connection behavior.
    }
  }
  const connectionFailureCode = (error: unknown): RuntimeDiagnosticCode | 'cancelled' => {
    if (!(error instanceof GoogleConnectionFailure)) return 'connection_failed'
    switch (error.code) {
      case 'timeout':
      case 'authorization_failed':
      case 'network_error':
      case 'redirect_refused':
      case 'provider_error':
      case 'invalid_response':
      case 'identity_unavailable':
      case 'account_missing':
      case 'identity_changed':
      case 'identity_mismatch':
        return error.code
      case 'cancelled':
        return 'cancelled'
      default:
        return 'connection_failed'
    }
  }
  const cancelOperation = (accountId: string): Promise<boolean> => {
    const operation = active.get(accountId)
    if (!operation) return Promise.resolve(true)
    active.delete(accountId)
    operation.cancel()
    if (operation.phase === 'accepting') {
      return dependencies.manager.disconnect(accountId).then(
        () => true,
        () => false
      )
    }
    return Promise.resolve(true)
  }

  return {
    async getStatus(accountId): Promise<GoogleConnectionStatusDto> {
      if (!dependencies.accountExists(accountId)) return status(accountId, 'error')
      if (active.has(accountId)) return status(accountId, 'connecting')
      const expected = generation(accountId)
      try {
        const current = await dependencies.manager.getStatus(accountId)
        if (generation(accountId) !== expected) {
          return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
        }
        return status(accountId, current.status)
      } catch {
        return status(accountId, generation(accountId) === expected ? 'error' : 'disconnected')
      }
    },
    async connect(accountId): Promise<GoogleConnectionStatusDto> {
      if (!dependencies.accountExists(accountId)) return status(accountId, 'error')
      const expected = advance(accountId)
      const cleanup = cancelOperation(accountId)
      if (!(await cleanup)) return status(accountId, 'error')
      if (generation(accountId) !== expected || active.has(accountId)) {
        return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
      }
      let connection: ReturnType<typeof startGoogleConnection>
      let config: GoogleOAuthConfig
      try {
        config = dependencies.loadConfig()
        if (generation(accountId) !== expected) {
          return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
        }
      } catch {
        reportFailure('config', 'config_unavailable')
        return status(accountId, 'error')
      }
      try {
        connection = startGoogleConnection(accountId, config, {
          readWebIdentity: dependencies.readWebIdentity,
          startAuthorization: dependencies.startAuthorization,
          exchangeCode: dependencies.exchangeCode,
          fetchProfile: dependencies.fetchProfile
        })
      } catch {
        reportFailure('connection', 'connection_start_failed')
        return status(accountId, 'error')
      }
      const operation: ActiveOperation = {
        phase: 'connecting',
        cancel: connection.cancel
      }
      active.set(accountId, operation)
      try {
        const result = await connection.result
        if (
          active.get(accountId) !== operation ||
          generation(accountId) !== expected ||
          !dependencies.accountExists(accountId)
        )
          return status(accountId, 'disconnected')
        operation.phase = 'accepting'
        await dependencies.manager.acceptConnection(accountId, result)
        if (
          active.get(accountId) !== operation ||
          generation(accountId) !== expected ||
          !dependencies.accountExists(accountId)
        ) {
          return status(accountId, 'disconnected')
        }
        active.delete(accountId)
        return status(accountId, 'connected')
      } catch (error) {
        if (active.get(accountId) === operation) active.delete(accountId)
        if (operation.phase === 'accepting') {
          reportFailure('persistence', 'accept_failed')
          return status(accountId, 'error')
        }
        const failureCode = connectionFailureCode(error)
        if (failureCode === 'cancelled') {
          return status(accountId, 'disconnected')
        }
        reportFailure('connection', failureCode)
        return status(accountId, 'error')
      }
    },
    async cancel(accountId): Promise<GoogleConnectionStatusDto> {
      const expected = advance(accountId)
      const cleanup = cancelOperation(accountId)
      if (!(await cleanup)) return status(accountId, 'error')
      if (generation(accountId) !== expected) {
        return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
      }
      if (!dependencies.accountExists(accountId)) return status(accountId, 'disconnected')
      try {
        const current = await dependencies.manager.getStatus(accountId)
        if (generation(accountId) !== expected) {
          return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
        }
        return status(accountId, current.status)
      } catch {
        return status(accountId, generation(accountId) === expected ? 'error' : 'disconnected')
      }
    },
    async disconnect(accountId): Promise<GoogleConnectionStatusDto> {
      const expected = advance(accountId)
      const cleanup = cancelOperation(accountId)
      if (!(await cleanup)) return status(accountId, 'error')
      if (generation(accountId) !== expected || active.has(accountId)) {
        return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
      }
      if (!dependencies.accountExists(accountId)) return status(accountId, 'disconnected')
      try {
        await dependencies.manager.disconnect(accountId)
        if (generation(accountId) !== expected) {
          return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
        }
        return status(accountId, 'disconnected')
      } catch {
        return status(accountId, generation(accountId) === expected ? 'error' : 'disconnected')
      }
    },
    async cancelAll(): Promise<void> {
      const ids = [...generations.keys()]
      for (const id of ids) advance(id)
      const outcomes = await Promise.all(ids.map((id) => cancelOperation(id)))
      if (outcomes.some((succeeded) => !succeeded)) {
        throw new Error('Unable to cancel pending Google connections')
      }
    }
  }
}
