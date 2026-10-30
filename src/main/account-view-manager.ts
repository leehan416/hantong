import type { BrowserWindow, WebContentsView } from 'electron'
import type { AccountState } from '../shared/accounts'
import type { AccountRemovalOutcome } from '../shared/ipc'
import type { AccountSelectorPosition } from '../shared/settings'
import type { AccountViewSnapshot, AccountViewStatus } from '../shared/ipc'
import { getAccountSession } from './account-session'
import { createGmailView } from './gmail-view'
import { createGoogleWebIdentityReader, isAllowedGmailIdentityUrl } from './google-web-identity'
import { getAccountViewBounds } from '../shared/account-layout'
import type { GmailDocumentState, ViewEntry, ViewHandle } from './account-view-types'
import { createAccountViewLifecycle } from './account-view-lifecycle'
import type { GmailViewLoadDiagnostic } from './account-view-lifecycle'
import type { NavigationDiagnostic } from './navigation-diagnostic'
import type { LogoutRequestStartDecision, LogoutRequestSuccessDecision } from './gmail-view'

export type LogoutFlowDiagnostic =
  | {
      stage: 'readiness'
      outcome:
        | 'ready'
        | 'not_locked'
        | 'navigation_not_started'
        | 'navigation_revision_mismatch'
        | 'not_sign_in_document'
        | 'document_not_loaded'
        | 'document_loading'
      requestId?: number
      source: 'dom_ready' | 'frame_finish' | 'stop_loading'
      documentKind: 'sign_in' | 'mail' | 'unknown'
      navigationRevision: number
      expectedNavigationRevision: number | null
      accessRevision: number
      readyRevision: number | null
      loading: boolean
    }
  | {
      stage: 'confirmation'
      outcome:
        | 'waiting_for_http_success'
        | 'waiting_for_ready_sign_in'
        | 'navigation_revision_mismatch'
        | 'access_revision_mismatch'
        | 'confirmed'
        | 'stale_view'
      requestId?: number
      navigationRevision: number
      expectedNavigationRevision: number | null
      accessRevision: number
      readyRevision: number | null
    }
  | {
      stage: 'removal'
      outcome: 'started' | AccountRemovalOutcome | 'skipped'
      requestId?: number
    }

interface AccountStore {
  getState: () => AccountState
}

export type { GmailDocumentState } from './account-view-types'

export function createAccountViewManager(
  window: BrowserWindow,
  accountStore: AccountStore,
  report: (status: AccountViewStatus) => void,
  openExternal: (url: string) => Promise<void>,
  loadTimeoutMs = 30_000,
  reportIdentityFailure?: Parameters<typeof createGoogleWebIdentityReader>[1],
  reportLoadDiagnostic?: (id: string, diagnostic: GmailViewLoadDiagnostic) => void,
  reportNavigationDiagnostic?: (id: string, diagnostic: NavigationDiagnostic) => void,
  onExplicitLogout?: (
    id: string
  ) => AccountRemovalOutcome | 'skipped' | Promise<AccountRemovalOutcome | 'skipped'>,
  onAccessInvalidated?: (id: string) => void,
  reportLogoutFlow?: (diagnostic: LogoutFlowDiagnostic) => void
): {
  activate: (id: string) => void
  retry: () => void
  disposeAccount: (id: string) => Promise<void>
  readWebIdentity: (
    id: string,
    signal?: AbortSignal
  ) => Promise<{ accountExists: boolean; emailAddress: string | null }>
  getDocumentState: (id: string) => GmailDocumentState
  setMailAccess: (id: string, allowed: boolean, expectedRevision?: number) => boolean
  clearLogoutLock: (id: string, recoveryPending?: boolean) => boolean
  forgetLogoutLock: (id: string) => boolean
  getActiveAccountId: () => string | null
  setCovered: (covered: boolean) => Promise<AccountViewSnapshot | null>
  setLayout: (position: AccountSelectorPosition, sidebarCollapsed: boolean) => void
  setStatusStripVisible: (visible: boolean) => void
  dispose: () => Promise<void>
} {
  const views = new Map<string, ViewEntry>()
  const logoutLocks = new Map<string, 'pending' | 'failed' | 'recovering' | 'confirmed'>()
  const identityReader = createGoogleWebIdentityReader((id) => {
    const entry = views.get(id)
    return entry
      ? {
          contents: entry.handle.view.webContents,
          revision: () => entry.navigationRevision,
          readinessFailure: () => {
            if (disposed) return 'manager_disposed'
            if (entry.disposePromise) return 'view_disposing'
            if (entry.loading) return 'view_loading'
            if (entry.blocked) return 'view_blocked'
            return 'view_not_loaded'
          },
          eligible: () =>
            !disposed &&
            !entry.logoutLocked &&
            !entry.loading &&
            entry.loaded &&
            !entry.blocked &&
            !entry.disposePromise &&
            accountStore.getState().accounts.some((account) => account.id === id)
        }
      : undefined
  }, reportIdentityFailure)
  let activeAccountId: string | null = null
  // A full-window local panel (settings) is showing, so the native Gmail view must not sit on top.
  let covered = false
  let layoutPosition: AccountSelectorPosition = 'top'
  let sidebarCollapsed = false
  let statusStripVisible = true
  let disposed = false

  function alive(): boolean {
    return !disposed && !window.isDestroyed()
  }

  function publish(accountId: string, status: AccountViewStatus['status']): void {
    const entry = views.get(accountId)
    if (entry?.logoutRecoveryPending) {
      if (status === 'ready' && entry.loaded && !entry.loading && !entry.blocked) {
        entry.logoutRecoveryPending = false
        entry.logoutFailed = false
        entry.logoutLocked = false
        logoutLocks.delete(accountId)
        reconcileVisibility(accountId, entry)
      } else if (status === 'blocked' || status === 'error') {
        entry.logoutRecoveryPending = false
        entry.logoutFailed = true
        entry.logoutLocked = true
        entry.mailAccessGranted = false
        entry.handle.revokeMailAccess()
        logoutLocks.set(accountId, 'failed')
        reconcileVisibility(accountId, entry)
      }
    }
    if (alive() && activeAccountId === accountId) report({ accountId, status })
  }

  function emitLogoutDiagnostic(diagnostic: LogoutFlowDiagnostic): void {
    try {
      reportLogoutFlow?.(diagnostic)
    } catch {
      // Development diagnostics must not affect logout or navigation.
    }
  }

  function setBounds(view: WebContentsView): void {
    if (!alive()) return
    view.setBounds(
      getAccountViewBounds({
        ...window.getContentBounds(),
        position: layoutPosition,
        sidebarCollapsed,
        statusStripVisible
      })
    )
  }

  function reconcileVisibility(id: string, entry: ViewEntry): void {
    const signInDocument =
      lifecycle.documentKind(entry.committedUrl) === 'sign_in' &&
      (!entry.mainFrameNavigationPending || entry.pendingMainFrameKind === 'sign_in')
    const shouldAttach =
      !covered &&
      activeAccountId === id &&
      !entry.disposePromise &&
      ((!entry.logoutFailed && signInDocument) ||
        (!entry.loading && !entry.mainFrameNavigationPending && entry.mailAccessGranted))
    if (shouldAttach && !entry.attached) {
      window.contentView.addChildView(entry.handle.view)
      entry.attached = true
      setBounds(entry.handle.view)
    } else if (!shouldAttach && entry.attached) {
      window.contentView.removeChildView(entry.handle.view)
      entry.attached = false
    }
  }

  const lifecycle = createAccountViewLifecycle({
    loadTimeoutMs,
    isAlive: alive,
    isCurrent: (id, entry) => views.get(id) === entry,
    isActive: (id) => activeAccountId === id,
    publish,
    reconcileVisibility,
    onAccessInvalidated,
    reportLoadDiagnostic
  })

  window.on('resize', () => {
    const entry = activeAccountId ? views.get(activeAccountId) : undefined
    if (entry?.attached) setBounds(entry.handle.view)
  })

  function activate(id: string): void {
    if (!alive()) return
    if (!accountStore.getState().accounts.some((account) => account.id === id)) {
      throw new Error('Invalid account data')
    }
    if (activeAccountId && activeAccountId !== id) {
      const previous = views.get(activeAccountId)
      if (previous?.attached) {
        window.contentView.removeChildView(previous.handle.view)
        previous.attached = false
      }
    }
    activeAccountId = id
    let entry = views.get(id)
    if (!entry) {
      let handle: ViewHandle
      let ownEntry: ViewEntry | null = null
      try {
        handle = createGmailView(getAccountSession(id), {
          openExternal,
          onNavigationBlocked: (diagnostic) => {
            try {
              reportNavigationDiagnostic?.(id, diagnostic)
            } catch {
              // Diagnostics must never affect navigation policy.
            }
            const current = views.get(id)
            if (current) {
              current.blocked = true
              publish(id, 'blocked')
            }
          },
          onMainFrameNavigation: (url) => {
            const current = views.get(id)
            if (!current) return
            const nextKind = lifecycle.documentKind(url)
            try {
              const previousUrl = new URL(current.committedUrl)
              const nextUrl = new URL(url)
              if (
                previousUrl.origin !== nextUrl.origin ||
                previousUrl.pathname !== nextUrl.pathname
              ) {
                current.accessRevision += 1
                current.mailAccessGranted = false
                current.handle.revokeMailAccess()
              }
            } catch {
              current.accessRevision += 1
              current.mailAccessGranted = false
              current.handle.revokeMailAccess()
            }
            if (nextKind !== 'mail' && current.mailAccessGranted) {
              current.mailAccessGranted = false
              current.handle.revokeMailAccess()
            }
            const committedKind = lifecycle.documentKind(current.committedUrl)
            if (
              (nextKind !== 'sign_in' || committedKind !== 'sign_in') &&
              !current.mailAccessGranted &&
              current.attached
            ) {
              window.contentView.removeChildView(current.handle.view)
              current.attached = false
            }
          },
          isMailAccessAllowed: () => views.get(id)?.mailAccessGranted ?? false,
          onLogoutRequestStart: (requestId): LogoutRequestStartDecision => {
            const current = views.get(id)
            if (!ownEntry || current !== ownEntry) return 'stale_view'
            if (current.disposePromise) return 'disposed'
            if (current.logoutConfirmed) return 'already_confirmed'
            if (current.logoutFailed || current.logoutRecoveryPending) return 'request_pending'
            if (current.logoutRequestId !== null) return 'request_pending'
            if (!accountStore.getState().accounts.some((account) => account.id === id))
              return 'account_missing'
            if (!current.accessEverGranted) return 'not_established'
            current.logoutRequestId = requestId
            current.logoutFlowRequestId = requestId
            current.logoutCompleted = false
            current.logoutSignInReady = false
            current.logoutConfirmed = false
            current.logoutLocked = true
            logoutLocks.set(id, 'pending')
            const signInNavigationPending =
              current.mainFrameNavigationPending && current.pendingMainFrameKind === 'sign_in'
            current.logoutExpectedNavigationRevision =
              current.navigationRevision + (signInNavigationPending ? 0 : 1)
            current.logoutNavigationStarted = signInNavigationPending
            current.logoutReadyRevision = null
            current.logoutTerminalRedirect = false
            current.logoutFailed = false
            current.logoutRecoveryPending = false
            current.accessRevision += 1
            current.mailAccessGranted = false
            current.handle.revokeMailAccess()
            reconcileVisibility(id, current)
            publish(id, 'loading')
            try {
              onAccessInvalidated?.(id)
            } catch {
              // Logout locking must proceed even if cache invalidation fails.
            }
            return 'accepted'
          },
          onLogoutRequestSuccess: (requestId): LogoutRequestSuccessDecision => {
            const current = views.get(id)
            if (
              !ownEntry ||
              !alive() ||
              current !== ownEntry ||
              current.disposePromise ||
              current.logoutRequestId !== requestId
            )
              return 'stale_request'
            current.logoutRequestId = null
            current.logoutCompleted = true
            return confirmLogout(id, current) ? 'confirmed' : 'awaiting_ready_sign_in'
          },
          onLogoutRequestFailure: (requestId) => {
            const current = views.get(id)
            if (
              !ownEntry ||
              current !== ownEntry ||
              current.disposePromise ||
              current.logoutRequestId !== requestId
            )
              return
            current.logoutRequestId = null
            current.logoutCompleted = false
            current.logoutSignInReady = false
            current.logoutTerminalRedirect = false
            current.logoutFlowRequestId = null
            current.logoutFailed = true
            current.logoutRecoveryPending = false
            logoutLocks.set(id, 'failed')
            reconcileVisibility(id, current)
            publish(id, 'error')
          },
          onLogoutTerminalRedirect: (): boolean => {
            const current = views.get(id)
            if (
              !ownEntry ||
              !alive() ||
              current !== ownEntry ||
              current.disposePromise ||
              !current.logoutLocked ||
              current.logoutFlowRequestId === null ||
              current.logoutConfirmed ||
              !accountStore.getState().accounts.some((account) => account.id === id)
            )
              return false
            current.logoutTerminalRedirect = true
            confirmLogout(id, current)
            return true
          }
        })
      } catch {
        publish(id, 'error')
        return
      }
      const createdEntry: ViewEntry = {
        handle,
        loaded: false,
        loading: false,
        attached: false,
        blocked: false,
        loadNumber: 0,
        timeout: null,
        disposePromise: null,
        navigationRevision: 0,
        accessRevision: 0,
        mainFrameNavigationPending: false,
        pendingMainFrameKind: null,
        mainFrameDocumentLoaded: false,
        mailAccessGranted: false,
        committedUrl: handle.view.webContents.getURL(),
        accessEverGranted: false,
        logoutRequestId: null,
        logoutCompleted: false,
        logoutSignInReady: false,
        logoutConfirmed: logoutLocks.get(id) === 'confirmed',
        logoutLocked: logoutLocks.has(id) && logoutLocks.get(id) !== 'recovering',
        logoutFlowRequestId: null,
        logoutNavigationStarted: false,
        logoutExpectedNavigationRevision: null,
        logoutReadyRevision: null,
        logoutTerminalRedirect: false,
        logoutFailed: logoutLocks.get(id) === 'failed',
        logoutRecoveryPending: logoutLocks.get(id) === 'recovering'
      }
      ownEntry = createdEntry
      entry = createdEntry
      views.set(id, createdEntry)
      lifecycle.register(id, createdEntry)
      const recordLogoutSignInReady = (
        source: 'dom_ready' | 'frame_finish' | 'stop_loading'
      ): void => {
        if (createdEntry.logoutFlowRequestId === null) return
        const contents = handle.view.webContents
        if (
          !alive() ||
          views.get(id) !== createdEntry ||
          createdEntry.disposePromise ||
          contents.isDestroyed()
        )
          return
        const documentKind = lifecycle.documentKind(handle.view.webContents.getURL())
        const nativeLoading = contents.isLoadingMainFrame()
        const outcome = !createdEntry.logoutLocked
          ? 'not_locked'
          : !createdEntry.logoutNavigationStarted
            ? 'navigation_not_started'
            : createdEntry.logoutExpectedNavigationRevision !== createdEntry.navigationRevision
              ? 'navigation_revision_mismatch'
              : documentKind !== 'sign_in'
                ? 'not_sign_in_document'
                : nativeLoading
                  ? 'document_loading'
                  : !createdEntry.loaded || createdEntry.loading
                    ? 'document_not_loaded'
                    : 'ready'
        emitLogoutDiagnostic({
          stage: 'readiness',
          outcome,
          requestId: createdEntry.logoutFlowRequestId,
          source,
          documentKind,
          navigationRevision: createdEntry.navigationRevision,
          expectedNavigationRevision: createdEntry.logoutExpectedNavigationRevision,
          accessRevision: createdEntry.accessRevision,
          readyRevision: createdEntry.logoutReadyRevision,
          loading: nativeLoading || createdEntry.loading
        })
        if (outcome !== 'ready') return
        createdEntry.logoutSignInReady = true
        createdEntry.logoutReadyRevision = createdEntry.accessRevision
        confirmLogout(id, createdEntry)
      }
      handle.view.webContents.on('did-start-navigation', (details) => {
        if (!details.isMainFrame || views.get(id) !== createdEntry) return
        createdEntry.logoutSignInReady = false
        createdEntry.logoutReadyRevision = null
        if (
          createdEntry.logoutLocked &&
          createdEntry.navigationRevision === createdEntry.logoutExpectedNavigationRevision
        )
          createdEntry.logoutNavigationStarted = true
      })
      handle.view.webContents.on('dom-ready', () => recordLogoutSignInReady('dom_ready'))
      handle.view.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
        if (isMainFrame) recordLogoutSignInReady('frame_finish')
      })
      handle.view.webContents.on('did-stop-loading', () => recordLogoutSignInReady('stop_loading'))
    }
    reconcileVisibility(id, entry)
    if (entry.loaded) {
      publish(id, entry.blocked ? 'blocked' : 'ready')
    } else if (!entry.loading) {
      setBounds(entry.handle.view)
      lifecycle.load(id, entry)
    } else {
      publish(id, 'loading')
    }
  }

  function retry(): void {
    if (!alive()) return
    const id = activeAccountId ?? accountStore.getState().activeAccountId
    if (!id) return
    if (!activeAccountId) {
      activate(id)
      return
    }
    const entry = views.get(id)
    if (entry) lifecycle.retry(id, entry)
    else activate(id)
  }

  function confirmLogout(id: string, entry: ViewEntry): boolean {
    if (entry.logoutFlowRequestId === null || entry.logoutConfirmed) return entry.logoutConfirmed
    let outcome: Extract<LogoutFlowDiagnostic, { stage: 'confirmation' }>['outcome'] | null = null
    if (!entry.logoutCompleted) outcome = 'waiting_for_http_success'
    else if (!entry.logoutSignInReady && !entry.logoutTerminalRedirect)
      outcome = 'waiting_for_ready_sign_in'
    else if (
      !entry.logoutTerminalRedirect &&
      entry.logoutExpectedNavigationRevision !== entry.navigationRevision
    )
      outcome = 'navigation_revision_mismatch'
    else if (!entry.logoutTerminalRedirect && entry.logoutReadyRevision !== entry.accessRevision)
      outcome = 'access_revision_mismatch'
    else if (!alive() || entry.disposePromise || views.get(id) !== entry) outcome = 'stale_view'
    if (outcome) {
      emitLogoutDiagnostic({
        stage: 'confirmation',
        outcome,
        requestId: entry.logoutFlowRequestId,
        navigationRevision: entry.navigationRevision,
        expectedNavigationRevision: entry.logoutExpectedNavigationRevision,
        accessRevision: entry.accessRevision,
        readyRevision: entry.logoutReadyRevision
      })
      return false
    }
    entry.logoutConfirmed = true
    logoutLocks.set(id, 'confirmed')
    entry.logoutRequestId = null
    emitLogoutDiagnostic({
      stage: 'confirmation',
      outcome: 'confirmed',
      requestId: entry.logoutFlowRequestId,
      navigationRevision: entry.navigationRevision,
      expectedNavigationRevision: entry.logoutExpectedNavigationRevision,
      accessRevision: entry.accessRevision,
      readyRevision: entry.logoutReadyRevision
    })
    emitLogoutDiagnostic({
      stage: 'removal',
      outcome: 'started',
      requestId: entry.logoutFlowRequestId
    })
    try {
      const result = onExplicitLogout?.(id)
      void Promise.resolve(result ?? 'skipped').then(
        (removalOutcome) =>
          emitLogoutDiagnostic({
            stage: 'removal',
            outcome: removalOutcome,
            requestId: entry.logoutFlowRequestId ?? undefined
          }),
        () =>
          emitLogoutDiagnostic({
            stage: 'removal',
            outcome: 'failed',
            requestId: entry.logoutFlowRequestId ?? undefined
          })
      )
    } catch {
      // The lock remains in place when account cleanup cannot start.
      emitLogoutDiagnostic({
        stage: 'removal',
        outcome: 'failed',
        requestId: entry.logoutFlowRequestId
      })
    }
    return true
  }

  function disposeAccount(id: string): Promise<void> {
    const entry = views.get(id)
    if (!entry) return Promise.resolve()
    if (entry.disposePromise) return entry.disposePromise
    lifecycle.invalidate(entry)
    if (activeAccountId === id) activeAccountId = null
    if (entry.attached && !window.isDestroyed())
      window.contentView.removeChildView(entry.handle.view)
    entry.attached = false
    const attempt = Promise.resolve(entry.handle.dispose()).then(() => {
      if (views.get(id) === entry) views.delete(id)
    })
    entry.disposePromise = attempt.catch((error: unknown) => {
      entry.disposePromise = null
      throw error
    })
    return entry.disposePromise
  }

  return {
    activate,
    retry,
    async setCovered(next) {
      if (covered === next) return null
      let snapshot: AccountViewSnapshot | null = null
      if (next && activeAccountId) {
        const id = activeAccountId
        const entry = views.get(id)
        const contents = entry?.handle.view.webContents
        if (entry?.attached && contents && !contents.isDestroyed()) {
          try {
            const image = await contents.capturePage()
            if (
              alive() &&
              activeAccountId === id &&
              views.get(id) === entry &&
              entry.attached &&
              !contents.isDestroyed()
            ) {
              snapshot = {
                accountId: id,
                bounds: entry.handle.view.getBounds(),
                dataUrl: image.toDataURL()
              }
            }
          } catch {
            // A failed snapshot must not keep a native view above the modal.
          }
        }
      }
      covered = next
      for (const [id, entry] of views) reconcileVisibility(id, entry)
      return snapshot
    },
    setLayout(position, collapsed) {
      layoutPosition = position
      sidebarCollapsed = collapsed
      const entry = activeAccountId ? views.get(activeAccountId) : undefined
      if (entry?.attached) setBounds(entry.handle.view)
    },
    setStatusStripVisible(visible) {
      if (statusStripVisible === visible) return
      statusStripVisible = visible
      const entry = activeAccountId ? views.get(activeAccountId) : undefined
      if (entry?.attached) setBounds(entry.handle.view)
    },
    disposeAccount,
    async readWebIdentity(id, signal) {
      const accountExists = (): boolean =>
        accountStore.getState().accounts.some((account) => account.id === id)
      if (!accountExists()) return { accountExists: false, emailAddress: null }
      const identity = await identityReader.read(id, signal)
      if (!accountExists()) return { accountExists: false, emailAddress: null }
      return identity ?? { accountExists: true, emailAddress: null }
    },
    getDocumentState(id) {
      const entry = views.get(id)
      if (!entry) return { revision: 0, kind: 'unknown', ready: false }
      return {
        revision: entry.accessRevision,
        kind: lifecycle.documentKind(entry.committedUrl),
        ready:
          !entry.logoutLocked &&
          entry.loaded &&
          !entry.loading &&
          !entry.blocked &&
          !entry.disposePromise,
        ...(entry.logoutFailed
          ? {
              logoutFailed: true,
              loaded: entry.loaded && !entry.loading && !entry.blocked && !entry.disposePromise
            }
          : {})
      }
    },
    setMailAccess(id, allowed, expectedRevision) {
      const entry = views.get(id)
      if (
        !entry ||
        !alive() ||
        !accountStore.getState().accounts.some((account) => account.id === id)
      )
        return false
      if (
        allowed &&
        (entry.logoutLocked ||
          expectedRevision === undefined ||
          entry.accessRevision !== expectedRevision ||
          !entry.loaded ||
          entry.loading ||
          entry.blocked ||
          lifecycle.documentKind(entry.committedUrl) !== 'mail' ||
          !isAllowedGmailIdentityUrl(entry.committedUrl))
      )
        return false
      entry.mailAccessGranted = allowed
      if (allowed) entry.accessEverGranted = true
      if (!allowed) entry.handle.revokeMailAccess()
      reconcileVisibility(id, entry)
      return true
    },
    clearLogoutLock(id, recoveryPending = false) {
      const entry = views.get(id)
      if (entry?.logoutRequestId !== null && entry?.logoutRequestId !== undefined) return false
      if (
        logoutLocks.get(id) === 'confirmed' ||
        logoutLocks.get(id) === 'pending' ||
        logoutLocks.get(id) === 'recovering' ||
        entry?.logoutConfirmed ||
        (entry?.logoutLocked && !entry.logoutFailed)
      )
        return false
      if (logoutLocks.get(id) === 'failed' && recoveryPending) {
        logoutLocks.set(id, 'recovering')
        if (!entry) return true
        entry.logoutLocked = false
        entry.logoutCompleted = false
        entry.logoutSignInReady = false
        entry.logoutFlowRequestId = null
        entry.logoutNavigationStarted = false
        entry.logoutExpectedNavigationRevision = null
        entry.logoutReadyRevision = null
        entry.logoutTerminalRedirect = false
        entry.logoutFailed = false
        entry.logoutRecoveryPending = true
        reconcileVisibility(id, entry)
        return true
      }
      logoutLocks.delete(id)
      if (!entry) return true
      entry.logoutLocked = false
      entry.logoutCompleted = false
      entry.logoutSignInReady = false
      entry.logoutFlowRequestId = null
      entry.logoutNavigationStarted = false
      entry.logoutExpectedNavigationRevision = null
      entry.logoutReadyRevision = null
      entry.logoutTerminalRedirect = false
      entry.logoutFailed = false
      entry.logoutRecoveryPending = false
      reconcileVisibility(id, entry)
      return true
    },
    forgetLogoutLock(id) {
      if (accountStore.getState().accounts.some((account) => account.id === id)) return false
      logoutLocks.delete(id)
      return true
    },
    getActiveAccountId() {
      return activeAccountId
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      activeAccountId = null
      await Promise.all([...views.keys()].map((id) => disposeAccount(id)))
    }
  }
}
