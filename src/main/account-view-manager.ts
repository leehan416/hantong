import type { BrowserWindow, WebContentsView } from 'electron'
import type { AccountState } from '../shared/accounts'
import type { AccountSelectorPosition } from '../shared/settings'
import type { AccountViewSnapshot, AccountViewStatus } from '../shared/ipc'
import { getAccountSession } from './account-session'
import { createGmailView } from './gmail-view'
import { createGoogleWebIdentityReader, isAllowedGmailIdentityUrl } from './google-web-identity'
import { getAccountViewBounds } from '../shared/account-layout'
import type { GmailDocumentState, ViewEntry, ViewHandle } from './account-view-types'
import { createAccountViewLifecycle } from './account-view-lifecycle'

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
  reportIdentityFailure?: Parameters<typeof createGoogleWebIdentityReader>[1]
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
  getActiveAccountId: () => string | null
  setCovered: (covered: boolean) => Promise<AccountViewSnapshot | null>
  setLayout: (position: AccountSelectorPosition, sidebarCollapsed: boolean) => void
  setStatusStripVisible: (visible: boolean) => void
  dispose: () => Promise<void>
} {
  const views = new Map<string, ViewEntry>()
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
    if (alive() && activeAccountId === accountId) report({ accountId, status })
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
      (signInDocument ||
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
    reconcileVisibility
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
      try {
        handle = createGmailView(getAccountSession(id), {
          openExternal,
          onNavigationBlocked: () => {
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
          isMailAccessAllowed: () => views.get(id)?.mailAccessGranted ?? false
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
        committedUrl: handle.view.webContents.getURL()
      }
      entry = createdEntry
      views.set(id, createdEntry)
      lifecycle.register(id, createdEntry)
    }
    reconcileVisibility(id, entry)
    if (entry.loaded) {
      publish(id, entry.blocked ? 'blocked' : 'ready')
    } else if (!entry.loading) {
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
        ready: entry.loaded && !entry.loading && !entry.blocked && !entry.disposePromise
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
        (expectedRevision === undefined ||
          entry.accessRevision !== expectedRevision ||
          !entry.loaded ||
          entry.loading ||
          entry.blocked ||
          lifecycle.documentKind(entry.committedUrl) !== 'mail' ||
          !isAllowedGmailIdentityUrl(entry.committedUrl))
      )
        return false
      entry.mailAccessGranted = allowed
      if (!allowed) entry.handle.revokeMailAccess()
      reconcileVisibility(id, entry)
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
