import { RelayFailure } from './relay-client'
import type { RelaySignal } from './relay-client'

interface RelayClient {
  createSession(
    idToken: string,
    nonce: string,
    installationId: string,
    signal?: AbortSignal
  ): Promise<{ readonly accessToken: string; readonly expiresAt: number }>
  deleteSession(token: string): Promise<void>
  consumeEvents(
    token: string,
    onEvent: (event: RelaySignal) => void,
    signal?: AbortSignal
  ): Promise<void>
}

interface RelayRuntimeDependencies {
  readonly client: RelayClient
  readonly accountExists: (accountId: string) => boolean
  readonly now: () => number
  readonly onSignal: (accountId: string, event: RelaySignal) => void
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
}

interface Operation {
  readonly controller: AbortController
  timer?: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  token?: string
  expiresAt?: number
  stopped: boolean
}

export function createRelayRuntime(dependencies: RelayRuntimeDependencies): {
  accept(accountId: string, proof: { readonly idToken?: string; readonly nonce?: string }): void
  disconnect(accountId: string): void
  dispose(): Promise<void>
} {
  const owned = new Map<string, Operation>()
  const schedule = dependencies.setTimeout ?? setTimeout
  const unschedule = dependencies.clearTimeout ?? clearTimeout
  const revoke = (token: string | undefined): void => {
    if (token) void dependencies.client.deleteSession(token).catch(() => undefined)
  }
  const invalidate = (accountId: string, expected?: Operation): void => {
    const operation = owned.get(accountId)
    if (!operation || (expected && operation !== expected)) return
    owned.delete(accountId)
    operation.stopped = true
    operation.controller.abort()
    if (operation.timer) unschedule(operation.timer)
    if (operation.expiryTimer) unschedule(operation.expiryTimer)
    const token = operation.token
    operation.token = undefined
    operation.expiresAt = undefined
    operation.timer = undefined
    operation.expiryTimer = undefined
    operationProof.delete(operation)
    revoke(token)
  }
  const current = (accountId: string, operation: Operation): boolean =>
    owned.get(accountId) === operation &&
    !operation.stopped &&
    !operation.controller.signal.aborted &&
    dependencies.accountExists(accountId)

  const run = async (accountId: string, operation: Operation): Promise<void> => {
    const idToken = operationProof.get(operation)?.idToken
    const nonce = operationProof.get(operation)?.nonce
    if (!idToken || !nonce) return
    let session: { readonly accessToken: string; readonly expiresAt: number }
    try {
      session = await dependencies.client.createSession(
        idToken,
        nonce,
        accountId,
        operation.controller.signal
      )
    } catch {
      operationProof.delete(operation)
      if (owned.get(accountId) === operation) owned.delete(accountId)
      operation.stopped = true
      operation.controller.abort()
      return
    }
    operationProof.delete(operation)
    if (!current(accountId, operation)) {
      revoke(session.accessToken)
      return
    }
    if (session.expiresAt <= dependencies.now()) {
      invalidate(accountId, operation)
      revoke(session.accessToken)
      return
    }
    operation.token = session.accessToken
    operation.expiresAt = session.expiresAt
    operation.expiryTimer = schedule(
      () => invalidate(accountId, operation),
      Math.max(0, session.expiresAt - dependencies.now())
    )
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

  const operationProof = new WeakMap<Operation, { idToken?: string; nonce?: string }>()
  return {
    accept(accountId, proof): void {
      invalidate(accountId)
      if (!proof.idToken || !proof.nonce || !dependencies.accountExists(accountId)) return
      const operation: Operation = { controller: new AbortController(), stopped: false }
      operationProof.set(operation, proof)
      owned.set(accountId, operation)
      void run(accountId, operation).catch(() => invalidate(accountId, operation))
    },
    disconnect(accountId): void {
      invalidate(accountId)
    },
    async dispose(): Promise<void> {
      const tokens: string[] = []
      for (const [accountId, operation] of owned) {
        owned.delete(accountId)
        operation.stopped = true
        operation.controller.abort()
        if (operation.timer) unschedule(operation.timer)
        if (operation.expiryTimer) unschedule(operation.expiryTimer)
        if (operation.token) tokens.push(operation.token)
        operation.token = undefined
        operation.expiresAt = undefined
        operation.timer = undefined
        operation.expiryTimer = undefined
        operationProof.delete(operation)
      }
      await Promise.all(
        tokens.map((token) => dependencies.client.deleteSession(token).catch(() => undefined))
      )
    }
  }
}
