import type { GoogleAuthorizationOperation } from './google-authorization'
import type { GoogleConnectionStatus } from '../shared/ipc'
import { GoogleConnectionFailure, startGoogleConnection } from './google-connection'
import type { GoogleConnectionFailureCode, GoogleConnectionResult } from './google-connection'
import type { GoogleOAuthConfig } from './google-oauth-config'
import type {
  OAuthDiagnosticCode,
  OAuthDiagnosticOutcome,
  OAuthDiagnosticStage
} from './main-diagnostics-types'

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
  readonly startAuthorization: (
    config: GoogleOAuthConfig,
    nonce?: string
  ) => GoogleAuthorizationOperation
  readonly prepareRelayChallenge?: (
    accountId: string,
    signal: AbortSignal
  ) => Promise<string | undefined>
  readonly exchangeCode: Parameters<typeof startGoogleConnection>[2]['exchangeCode']
  readonly fetchProfile: Parameters<typeof startGoogleConnection>[2]['fetchProfile']
  readonly manager: ConnectionManager
  readonly reportProgress?: (
    accountId: string,
    stage: OAuthDiagnosticStage,
    outcome: OAuthDiagnosticOutcome,
    code?: OAuthDiagnosticCode
  ) => void
  readonly onConnected?: (accountId: string, result: GoogleConnectionResult) => void
  readonly onAuthorizationReceived?: (accountId: string) => void
  readonly onDisconnected?: (accountId: string) => void
  readonly onPendingChanged?: () => void
}

interface ActiveOperation {
  readonly cancel: () => void
  phase: 'connecting' | 'accepting'
}

export function createGoogleConnectionRuntime(dependencies: RuntimeDependencies): {
  hasPendingConnections(): boolean
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
  const reportProgress = (
    accountId: string,
    stage: OAuthDiagnosticStage,
    outcome: OAuthDiagnosticOutcome,
    code?: OAuthDiagnosticCode
  ): void => {
    try {
      dependencies.reportProgress?.(accountId, stage, outcome, code)
    } catch {
      // Diagnostics must never affect connection behavior.
    }
  }
  const reportPendingChanged = (): void => {
    try {
      dependencies.onPendingChanged?.()
    } catch {
      // Alert scheduling cannot affect connection behavior.
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
    reportPendingChanged()
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
    hasPendingConnections(): boolean {
      return active.size > 0
    },
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
      reportProgress(accountId, 'config', 'started')
      try {
        config = dependencies.loadConfig()
        if (generation(accountId) !== expected) {
          return status(accountId, active.has(accountId) ? 'connecting' : 'disconnected')
        }
        reportProgress(accountId, 'config', 'success')
      } catch {
        reportProgress(accountId, 'config', 'failure', 'config_unavailable')
        return status(accountId, 'error')
      }
      reportProgress(accountId, 'connection', 'started')
      const operationRef: { current?: ActiveOperation } = {}
      try {
        connection = startGoogleConnection(accountId, config, {
          readWebIdentity: dependencies.readWebIdentity,
          startAuthorization: dependencies.startAuthorization,
          prepareRelayChallenge: dependencies.prepareRelayChallenge
            ? (signal) =>
                dependencies.prepareRelayChallenge?.(accountId, signal) ??
                Promise.resolve(undefined)
            : undefined,
          exchangeCode: dependencies.exchangeCode,
          fetchProfile: dependencies.fetchProfile,
          onAuthorizationReceived: () => {
            if (
              !operationRef.current ||
              active.get(accountId) !== operationRef.current ||
              generation(accountId) !== expected ||
              !dependencies.accountExists(accountId)
            )
              return
            dependencies.onAuthorizationReceived?.(accountId)
          },
          reportProgress: (stage, outcome, code) => reportProgress(accountId, stage, outcome, code)
        })
      } catch {
        reportProgress(accountId, 'connection', 'failure', 'connection_start_failed')
        return status(accountId, 'error')
      }
      const operation: ActiveOperation = {
        phase: 'connecting',
        cancel: connection.cancel
      }
      operationRef.current = operation
      active.set(accountId, operation)
      reportPendingChanged()
      try {
        const result = await connection.result
        if (
          active.get(accountId) !== operation ||
          generation(accountId) !== expected ||
          !dependencies.accountExists(accountId)
        )
          return status(accountId, 'disconnected')
        reportProgress(accountId, 'connection', 'success')
        operation.phase = 'accepting'
        reportProgress(accountId, 'persistence', 'started')
        await dependencies.manager.acceptConnection(accountId, result)
        if (
          active.get(accountId) !== operation ||
          generation(accountId) !== expected ||
          !dependencies.accountExists(accountId)
        ) {
          return status(accountId, 'disconnected')
        }
        reportProgress(accountId, 'persistence', 'success')
        active.delete(accountId)
        try {
          dependencies.onConnected?.(accountId, result)
        } catch {
          // Relay lifecycle observers cannot roll back an accepted Google grant.
        }
        reportPendingChanged()
        return status(accountId, 'connected')
      } catch (error) {
        if (active.get(accountId) === operation) {
          active.delete(accountId)
          reportPendingChanged()
        }
        if (operation.phase === 'accepting') {
          reportProgress(accountId, 'persistence', 'failure', 'accept_failed')
          return status(accountId, 'error')
        }
        const failureCode = connectionFailureCode(error)
        if (failureCode === 'cancelled') {
          reportProgress(accountId, 'connection', 'cancelled', failureCode)
          return status(accountId, 'disconnected')
        }
        reportProgress(accountId, 'connection', 'failure', failureCode)
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
      try {
        dependencies.onDisconnected?.(accountId)
      } catch {
        // A relay cleanup observer cannot block Google account cleanup.
      }
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
