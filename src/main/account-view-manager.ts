import type { BrowserWindow, WebContentsView } from 'electron'
import type { AccountState } from '../shared/accounts'
import type { AccountSelectorPosition } from '../shared/settings'
import type { AccountViewSnapshot, AccountViewStatus } from '../shared/ipc'
import { getAccountSession } from './account-session'
import { createGmailView } from './gmail-view'
import { createGoogleWebIdentityReader, isAllowedGmailIdentityUrl } from './google-web-identity'
import { classifyGmailNavigation } from './gmail-navigation'
import { getAccountViewBounds } from '../shared/account-layout'

interface AccountStore {
  getState: () => AccountState
}

interface ViewHandle {
  view: WebContentsView
  load: () => Promise<void>
  revokeMailAccess: () => void
  dispose: () => Promise<void>
}

interface ViewEntry {
  handle: ViewHandle
  loaded: boolean
  loading: boolean
  attached: boolean
  blocked: boolean
  loadNumber: number
  timeout: ReturnType<typeof setTimeout> | null
  disposePromise: Promise<void> | null
  navigationRevision: number
  accessRevision: number
  mainFrameNavigationPending: boolean
  mainFrameDocumentLoaded: boolean
  mailAccessGranted: boolean
  committedUrl: string
}

export interface GmailDocumentState {
  revision: number
  kind: 'sign_in' | 'mail' | 'unknown'
  ready: boolean
}

function documentKind(value: string): GmailDocumentState['kind'] {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return 'unknown'
    if (url.hostname === 'accounts.google.com' && classifyGmailNavigation(value) === 'internal')
      return 'sign_in'
    if (url.hostname === 'mail.google.com') return 'mail'
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

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
    const shouldAttach =
      !covered &&
      activeAccountId === id &&
      !entry.disposePromise &&
      !entry.loading &&
      !entry.mainFrameNavigationPending &&
      (entry.mailAccessGranted || documentKind(entry.committedUrl) === 'sign_in')
    if (shouldAttach && !entry.attached) {
      window.contentView.addChildView(entry.handle.view)
      entry.attached = true
      setBounds(entry.handle.view)
    } else if (!shouldAttach && entry.attached) {
      window.contentView.removeChildView(entry.handle.view)
      entry.attached = false
    }
  }

  function armLoadTimeout(id: string, entry: ViewEntry, loadNumber: number): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = setTimeout(() => {
      entry.timeout = null
      if (entry.loadNumber !== loadNumber) return
      entry.loadNumber += 1
      entry.loading = false
      entry.loaded = false
      entry.mainFrameNavigationPending = false
      entry.mainFrameDocumentLoaded = false
      entry.accessRevision += 1
      entry.mailAccessGranted = false
      entry.handle.revokeMailAccess()
      reconcileVisibility(id, entry)
      publish(id, 'error')
    }, loadTimeoutMs)
  }

  function finishSuccessfulMainFrameNavigation(id: string, entry: ViewEntry): void {
    const contents = entry.handle.view.webContents
    if (
      !alive() ||
      entry.disposePromise ||
      views.get(id) !== entry ||
      !entry.mainFrameNavigationPending ||
      !entry.mainFrameDocumentLoaded ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame()
    )
      return
    entry.mainFrameNavigationPending = false
    entry.mainFrameDocumentLoaded = false
    entry.loaded = true
    entry.loading = false
    entry.committedUrl = contents.getURL()
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = null
    entry.loadNumber += 1
    reconcileVisibility(id, entry)
    if (isAllowedGmailIdentityUrl(contents.getURL())) entry.blocked = false
    if (activeAccountId === id) publish(id, entry.blocked ? 'blocked' : 'ready')
  }

  window.on('resize', () => {
    const entry = activeAccountId ? views.get(activeAccountId) : undefined
    if (entry?.attached) setBounds(entry.handle.view)
  })

  function load(id: string, entry: ViewEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    const loadNumber = ++entry.loadNumber
    const navigationRevision = entry.navigationRevision
    entry.blocked = false
    entry.loaded = false
    entry.loading = true
    entry.mainFrameNavigationPending = false
    publish(id, 'loading')
    entry.mainFrameDocumentLoaded = false
    armLoadTimeout(id, entry, loadNumber)
    void entry.handle.load().then(
      () => {
        if (entry.loadNumber !== loadNumber || entry.navigationRevision !== navigationRevision)
          return
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        if (!alive()) return
        entry.loaded = true
        entry.loading = false
        entry.committedUrl = entry.handle.view.webContents.getURL()
        reconcileVisibility(id, entry)
        if (activeAccountId === id) publish(id, entry.blocked ? 'blocked' : 'ready')
      },
      () => {
        if (entry.loadNumber !== loadNumber || entry.navigationRevision !== navigationRevision)
          return
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        if (alive()) {
          entry.loading = false
          publish(id, entry.blocked ? 'blocked' : 'error')
        }
      }
    )
  }

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
            const nextKind = documentKind(url)
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
            const committedKind = documentKind(current.committedUrl)
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
      const createdEntry = {
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
        mainFrameDocumentLoaded: false,
        mailAccessGranted: false,
        committedUrl: handle.view.webContents.getURL()
      }
      entry = createdEntry
      views.set(id, createdEntry)
      handle.view.webContents.on('did-start-navigation', (details) => {
        if (
          !details.isMainFrame ||
          !alive() ||
          createdEntry.disposePromise ||
          views.get(id) !== createdEntry
        )
          return
        createdEntry.navigationRevision += 1
        if (details.isSameDocument) {
          let accountSlotChanged = false
          try {
            const current = new URL(createdEntry.committedUrl)
            const next = new URL(details.url)
            const currentSlot = current.pathname.match(/^\/mail\/u\/(\d+)(?:\/|$)/)?.[1]
            const nextSlot = next.pathname.match(/^\/mail\/u\/(\d+)(?:\/|$)/)?.[1]
            if (currentSlot && nextSlot && currentSlot !== nextSlot) {
              accountSlotChanged = true
              createdEntry.accessRevision += 1
              createdEntry.mailAccessGranted = false
              createdEntry.handle.revokeMailAccess()
              reconcileVisibility(id, createdEntry)
            }
            createdEntry.committedUrl = details.url
          } catch {
            createdEntry.accessRevision += 1
            createdEntry.mailAccessGranted = false
            createdEntry.handle.revokeMailAccess()
            reconcileVisibility(id, createdEntry)
          }
          if (accountSlotChanged && activeAccountId === id) publish(id, 'ready')
          return
        }
        createdEntry.accessRevision += 1
        createdEntry.mailAccessGranted = false
        createdEntry.handle.revokeMailAccess()
        createdEntry.loadNumber += 1
        createdEntry.mainFrameNavigationPending = true
        createdEntry.mainFrameDocumentLoaded = false
        createdEntry.loaded = false
        createdEntry.loading = true
        reconcileVisibility(id, createdEntry)
        armLoadTimeout(id, createdEntry, createdEntry.loadNumber)
        publish(id, 'loading')
      })
      handle.view.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
        const contents = handle.view.webContents
        if (!isMainFrame || !createdEntry.mainFrameNavigationPending || contents.isDestroyed())
          return
        createdEntry.mainFrameDocumentLoaded = true
        finishSuccessfulMainFrameNavigation(id, createdEntry)
      })
      handle.view.webContents.on('did-stop-loading', () => {
        finishSuccessfulMainFrameNavigation(id, createdEntry)
      })
      handle.view.webContents.on('render-process-gone', () => {
        if (createdEntry.timeout) clearTimeout(createdEntry.timeout)
        createdEntry.timeout = null
        createdEntry.loadNumber += 1
        createdEntry.loaded = false
        createdEntry.loading = false
        createdEntry.mainFrameNavigationPending = false
        createdEntry.mainFrameDocumentLoaded = false
        createdEntry.navigationRevision += 1
        createdEntry.accessRevision += 1
        createdEntry.mailAccessGranted = false
        createdEntry.handle.revokeMailAccess()
        reconcileVisibility(id, createdEntry)
        if (alive()) publish(id, 'error')
      })
      handle.view.webContents.on(
        'did-fail-load',
        (_event, errorCode, _description, validatedUrl, isMainFrame) => {
          const contents = handle.view.webContents
          if (
            !isMainFrame ||
            errorCode === -3 ||
            !alive() ||
            createdEntry.disposePromise ||
            views.get(id) !== createdEntry ||
            contents.isDestroyed() ||
            contents.isLoadingMainFrame() ||
            contents.getURL() !== validatedUrl
          )
            return
          createdEntry.loaded = false
          createdEntry.loading = false
          createdEntry.mainFrameNavigationPending = false
          createdEntry.mainFrameDocumentLoaded = false
          createdEntry.accessRevision += 1
          createdEntry.mailAccessGranted = false
          createdEntry.handle.revokeMailAccess()
          reconcileVisibility(id, createdEntry)
          if (createdEntry.timeout) clearTimeout(createdEntry.timeout)
          createdEntry.timeout = null
          createdEntry.loadNumber += 1
          publish(id, createdEntry.blocked ? 'blocked' : 'error')
        }
      )
    }
    reconcileVisibility(id, entry)
    if (entry.loaded) {
      publish(id, entry.blocked ? 'blocked' : 'ready')
    } else if (!entry.loading) {
      load(id, entry)
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
    if (entry) load(id, entry)
    else activate(id)
  }

  function disposeAccount(id: string): Promise<void> {
    const entry = views.get(id)
    if (!entry) return Promise.resolve()
    if (entry.disposePromise) return entry.disposePromise
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = null
    entry.navigationRevision += 1
    entry.loadNumber += 1
    entry.loaded = false
    entry.loading = false
    entry.mainFrameNavigationPending = false
    entry.mainFrameDocumentLoaded = false
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
              snapshot = { bounds: entry.handle.view.getBounds(), dataUrl: image.toDataURL() }
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
        kind: documentKind(entry.committedUrl),
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
          documentKind(entry.committedUrl) !== 'mail' ||
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
