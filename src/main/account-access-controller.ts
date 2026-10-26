import type { AccountAccessState } from '../shared/ipc'
import type { GmailDocumentState } from './account-view-manager'
import type { GoogleOAuthConfig } from './google-oauth-config'

interface AccessViews {
  getActiveAccountId(): string | null
  getDocumentState(accountId: string): GmailDocumentState
  readWebIdentity(
    accountId: string,
    signal?: AbortSignal
  ): Promise<{
    accountExists: boolean
    emailAddress: string | null
  }>
  setMailAccess(accountId: string, allowed: boolean, expectedRevision?: number): boolean
}

interface AccessRuntime {
  getStatus(accountId: string): Promise<{ status: AccountAccessState['connectionStatus'] }>
  connect(accountId: string): Promise<{ status: AccountAccessState['connectionStatus'] }>
  cancel(accountId: string): Promise<{ status: AccountAccessState['connectionStatus'] }>
  disconnect(accountId: string): Promise<{ status: AccountAccessState['connectionStatus'] }>
}

interface AccessConnections {
  getStatus(
    accountId: string
  ): Promise<
    | { status: 'disconnected' }
    | { status: 'connected'; emailAddress: string }
    | { status: 'reconnect_required'; emailAddress: string }
  >
  getAccessToken(accountId: string, config: GoogleOAuthConfig): Promise<string>
}

interface AccessDependencies {
  views: AccessViews
  runtime: AccessRuntime
  connections: AccessConnections
  loadConfig: () => GoogleOAuthConfig
  fetchProfile: (accessToken: string, signal: AbortSignal) => Promise<string>
  accountExists: (accountId: string) => boolean
  onWebIdentity: (accountId: string, emailAddress: string) => void
  publish: (state: AccountAccessState) => void
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
}

export function createAccountAccessController(dependencies: AccessDependencies): {
  getState(accountId: string): AccountAccessState
  onViewReady(accountId: string): void
  connect(accountId: string): Promise<AccountAccessState>
  cancel(accountId: string): Promise<AccountAccessState>
  disconnect(accountId: string): Promise<AccountAccessState>
  dispose(): void
} {
  const states = new Map<string, AccountAccessState>()
  const attempts = new Map<string, number>()
  const autoStarted = new Set<string>()
  const handledRevisions = new Map<string, number>()
  const autoSuppressed = new Set<string>()
  const controllers = new Map<string, AbortController>()
  const timer = dependencies.setTimeout ?? setTimeout
  const clear = dependencies.clearTimeout ?? clearTimeout
  const identityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let disposed = false
  let lastActiveAccountId: string | null = null

  function publish(
    accountId: string,
    status: AccountAccessState['status'],
    connectionStatus?: AccountAccessState['connectionStatus']
  ): AccountAccessState {
    const previous = states.get(accountId)
    const next: AccountAccessState = {
      accountId,
      status,
      connectionStatus: connectionStatus ?? previous?.connectionStatus ?? 'disconnected'
    }
    if (disposed) return previous ?? next
    states.set(accountId, next)
    try {
      dependencies.publish(next)
    } catch {
      // Renderer notification failures must not affect the access decision.
    }
    return next
  }

  function current(accountId: string, revision: number, expectedAttempt: number): boolean {
    const document = dependencies.views.getDocumentState(accountId)
    return (
      !disposed &&
      dependencies.accountExists(accountId) &&
      dependencies.views.getActiveAccountId() === accountId &&
      document.revision === revision &&
      document.kind === 'mail' &&
      document.ready &&
      (attempts.get(accountId) ?? 0) === expectedAttempt
    )
  }

  function revoke(accountId: string): number {
    const next = (attempts.get(accountId) ?? 0) + 1
    attempts.set(accountId, next)
    controllers.get(accountId)?.abort()
    controllers.delete(accountId)
    const pendingTimer = identityTimers.get(accountId)
    if (pendingTimer) clear(pendingTimer)
    identityTimers.delete(accountId)
    dependencies.views.setMailAccess(accountId, false)
    return next
  }

  // Gmail may still show its loading title right after the document is ready.
  async function readWebEmail(
    accountId: string,
    signal: AbortSignal,
    revision: number,
    expectedAttempt: number
  ): Promise<string | null> {
    for (let retry = 0; retry < 10; retry += 1) {
      if (!current(accountId, revision, expectedAttempt)) return null
      const identity = await dependencies.views.readWebIdentity(accountId, signal)
      if (!current(accountId, revision, expectedAttempt) || !identity.accountExists) return null
      if (identity.emailAddress) {
        dependencies.onWebIdentity(accountId, identity.emailAddress)
        return identity.emailAddress
      }
      if (retry < 9)
        await new Promise<void>((resolve) => {
          const handle = timer(() => {
            identityTimers.delete(accountId)
            resolve()
          }, 1_000)
          identityTimers.set(accountId, handle)
          signal.addEventListener(
            'abort',
            () => {
              clear(handle)
              identityTimers.delete(accountId)
              resolve()
            },
            { once: true }
          )
        })
    }
    return null
  }

  // The OAuth grant names the account; the Gmail page is read only to confirm it shows the same one.
  async function validateGrant(
    accountId: string,
    revision: number,
    expectedAttempt: number
  ): Promise<boolean> {
    const validationController = new AbortController()
    if (!current(accountId, revision, expectedAttempt)) return false
    controllers.set(accountId, validationController)
    try {
      const stored = await dependencies.connections.getStatus(accountId)
      if (!current(accountId, revision, expectedAttempt) || stored.status !== 'connected')
        return false
      const emailAddress = stored.emailAddress.toLowerCase()
      const accessToken = await dependencies.connections.getAccessToken(
        accountId,
        dependencies.loadConfig()
      )
      if (!current(accountId, revision, expectedAttempt)) return false
      const profileEmail = await dependencies.fetchProfile(accessToken, validationController.signal)
      if (!current(accountId, revision, expectedAttempt)) return false
      if (profileEmail.toLowerCase() !== emailAddress) return false
      const webEmail = await readWebEmail(
        accountId,
        validationController.signal,
        revision,
        expectedAttempt
      )
      if (!webEmail || webEmail.toLowerCase() !== emailAddress) return false
      return dependencies.views.setMailAccess(accountId, true, revision)
    } catch {
      return false
    } finally {
      if (controllers.get(accountId) === validationController) controllers.delete(accountId)
    }
  }

  async function connectAndValidate(
    accountId: string,
    revision: number,
    expectedAttempt: number,
    explicit: boolean
  ): Promise<AccountAccessState> {
    try {
      publish(accountId, 'checking', 'connecting')
      if (!explicit && autoSuppressed.has(accountId))
        return publish(accountId, 'required', 'disconnected')
      const stored = await dependencies.connections.getStatus(accountId)
      if (!current(accountId, revision, expectedAttempt)) return getState(accountId)
      if (stored.status === 'connected') {
        const valid = await validateGrant(accountId, revision, expectedAttempt)
        if (!current(accountId, revision, expectedAttempt)) return getState(accountId)
        if (valid) return publish(accountId, 'ready', 'connected')
        if (!explicit) return publish(accountId, 'error', 'reconnect_required')
      }
      if (!explicit && autoStarted.has(accountId))
        return publish(
          accountId,
          'required',
          stored.status === 'reconnect_required' ? 'reconnect_required' : 'disconnected'
        )
      autoStarted.add(accountId)
      const connected = await dependencies.runtime.connect(accountId)
      if (!current(accountId, revision, expectedAttempt)) return getState(accountId)
      if (connected.status !== 'connected') return publish(accountId, 'required', connected.status)
      const valid = await validateGrant(accountId, revision, expectedAttempt)
      if (!current(accountId, revision, expectedAttempt)) return getState(accountId)
      return valid
        ? publish(accountId, 'ready', 'connected')
        : publish(accountId, 'error', 'reconnect_required')
    } catch {
      if (!current(accountId, revision, expectedAttempt)) return getState(accountId)
      return publish(accountId, explicit ? 'error' : 'required', 'error')
    }
  }

  // Only the active account may hold a pending OAuth; a stale one would keep account switching locked.
  function releasePrevious(accountId: string): void {
    if (lastActiveAccountId && lastActiveAccountId !== accountId) {
      const previousAccountId = lastActiveAccountId
      const previous = getState(previousAccountId)
      revoke(previousAccountId)
      handledRevisions.delete(previousAccountId)
      if (previous.connectionStatus === 'connecting')
        void dependencies.runtime.cancel(previousAccountId)
      publish(
        previousAccountId,
        'required',
        previous.connectionStatus === 'connecting' ? 'disconnected' : previous.connectionStatus
      )
    }
    lastActiveAccountId = accountId
  }

  function getState(accountId: string): AccountAccessState {
    return (
      states.get(accountId) ?? { accountId, status: 'checking', connectionStatus: 'disconnected' }
    )
  }

  return {
    getState,
    onViewReady(accountId) {
      if (
        disposed ||
        !dependencies.accountExists(accountId) ||
        dependencies.views.getActiveAccountId() !== accountId
      )
        return
      releasePrevious(accountId)
      const document = dependencies.views.getDocumentState(accountId)
      if (document.kind === 'mail' && !document.ready) {
        revoke(accountId)
        if (getState(accountId).connectionStatus === 'connecting')
          void dependencies.runtime.cancel(accountId)
        publish(accountId, 'checking', getState(accountId).connectionStatus)
        return
      }
      if (document.kind === 'sign_in') {
        revoke(accountId)
        if (getState(accountId).connectionStatus === 'connecting')
          void dependencies.runtime.cancel(accountId)
        publish(accountId, 'sign_in', 'disconnected')
        return
      }
      if (
        !document.ready ||
        document.kind !== 'mail' ||
        handledRevisions.get(accountId) === document.revision
      )
        return
      handledRevisions.set(accountId, document.revision)
      const expectedAttempt = revoke(accountId)
      publish(accountId, 'checking')
      void connectAndValidate(accountId, document.revision, expectedAttempt, false)
    },
    async connect(accountId) {
      if (
        !dependencies.accountExists(accountId) ||
        dependencies.views.getActiveAccountId() !== accountId
      )
        return publish(accountId, 'error', 'error')
      const document = dependencies.views.getDocumentState(accountId)
      if (document.kind !== 'mail' || !document.ready)
        return publish(accountId, 'sign_in', 'disconnected')
      releasePrevious(accountId)
      handledRevisions.set(accountId, document.revision)
      autoSuppressed.delete(accountId)
      const expectedAttempt = revoke(accountId)
      publish(accountId, 'checking', 'connecting')
      return connectAndValidate(accountId, document.revision, expectedAttempt, true)
    },
    async cancel(accountId) {
      autoSuppressed.add(accountId)
      revoke(accountId)
      publish(accountId, 'required', 'disconnected')
      const expectedAttempt = attempts.get(accountId) ?? 0
      const result = await dependencies.runtime.cancel(accountId)
      if (disposed || attempts.get(accountId) !== expectedAttempt) return getState(accountId)
      return publish(accountId, 'required', result.status)
    },
    async disconnect(accountId) {
      autoSuppressed.add(accountId)
      revoke(accountId)
      publish(accountId, 'required', 'disconnected')
      const expectedAttempt = attempts.get(accountId) ?? 0
      const result = await dependencies.runtime.disconnect(accountId)
      if (disposed || attempts.get(accountId) !== expectedAttempt) return getState(accountId)
      return publish(accountId, 'required', result.status)
    },
    dispose() {
      disposed = true
      for (const accountId of attempts.keys()) revoke(accountId)
      for (const handle of identityTimers.values()) clear(handle)
      identityTimers.clear()
    }
  }
}
