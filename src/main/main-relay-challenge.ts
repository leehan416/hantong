import type { createMainDiagnostics } from './main-diagnostics'
import type { createRelayClient } from './relay-client'

export function createRelayChallengePreparation(dependencies: {
  readonly diagnostics: ReturnType<typeof createMainDiagnostics>
  readonly accountExists: (accountId: string) => boolean
  readonly resolveClient: () => ReturnType<typeof createRelayClient> | undefined
  readonly isPackaged: boolean
}): (accountId: string, signal: AbortSignal) => Promise<string | undefined> {
  return async (accountId, signal): Promise<string | undefined> => {
    dependencies.diagnostics.record({
      type: 'relay.bootstrap',
      accountId,
      stage: 'challenge',
      outcome: 'started'
    })
    try {
      const client = dependencies.resolveClient()
      if (!client) {
        dependencies.diagnostics.record({
          type: 'relay.bootstrap',
          accountId,
          stage: 'challenge',
          outcome: 'unavailable',
          code: 'unavailable'
        })
        return undefined
      }
      const nonce = (await client.fetchChallenge(signal)).nonce
      if (signal.aborted || !dependencies.accountExists(accountId)) {
        throw Object.assign(new Error('Relay challenge cancelled'), { code: 'cancelled' })
      }
      dependencies.diagnostics.record({
        type: 'relay.bootstrap',
        accountId,
        stage: 'challenge',
        outcome: 'success'
      })
      return nonce
    } catch (error) {
      if (
        signal.aborted ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'cancelled')
      ) {
        if (dependencies.accountExists(accountId))
          dependencies.diagnostics.record({
            type: 'relay.bootstrap',
            accountId,
            stage: 'challenge',
            outcome: 'skipped',
            code: 'cancelled'
          })
        throw Object.assign(new Error('Relay challenge cancelled'), { code: 'cancelled' })
      }
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        [
          'timeout',
          'network_error',
          'unauthorized',
          'rate_limited',
          'unavailable',
          'invalid_response',
          'redirect_refused'
        ].includes(error.code)
          ? (error.code as
              | 'timeout'
              | 'network_error'
              | 'unauthorized'
              | 'rate_limited'
              | 'unavailable'
              | 'invalid_response'
              | 'redirect_refused')
          : 'unknown'
      dependencies.diagnostics.record({
        type: 'relay.bootstrap',
        accountId,
        stage: 'challenge',
        outcome: 'failure',
        code
      })
      if (!dependencies.isPackaged) console.error('[Hantong Relay] unavailable')
      return undefined
    }
  }
}
