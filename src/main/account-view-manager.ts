import type { BrowserWindow, WebContentsView } from 'electron'
import type { AccountState } from '../shared/accounts'
import { ACCOUNT_CHROME_HEIGHT, type AccountViewStatus } from '../shared/ipc'
import { getAccountSession } from './account-session'
import { createGmailView } from './gmail-view'
import { createGoogleWebIdentityReader, isAllowedGmailIdentityUrl } from './google-web-identity'

interface AccountStore {
  getState: () => AccountState
}

interface ViewHandle {
  view: WebContentsView
  load: () => Promise<void>
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
  mainFrameNavigationPending: boolean
  mainFrameDocumentLoaded: boolean
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
  let disposed = false

  function alive(): boolean {
    return !disposed && !window.isDestroyed()
  }

  function publish(accountId: string, status: AccountViewStatus['status']): void {
    if (alive() && activeAccountId === accountId) report({ accountId, status })
  }

  function setBounds(view: WebContentsView): void {
    if (!alive()) return
    const { width, height } = window.getContentBounds()
    view.setBounds({
      x: 0,
      y: ACCOUNT_CHROME_HEIGHT,
      width,
      height: Math.max(0, height - ACCOUNT_CHROME_HEIGHT)
    })
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
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = null
    entry.loadNumber += 1
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
          }
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
        mainFrameNavigationPending: false,
        mainFrameDocumentLoaded: false
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
        if (details.isSameDocument) return
        createdEntry.loadNumber += 1
        createdEntry.mainFrameNavigationPending = true
        createdEntry.mainFrameDocumentLoaded = false
        createdEntry.loaded = false
        createdEntry.loading = true
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
          if (createdEntry.timeout) clearTimeout(createdEntry.timeout)
          createdEntry.timeout = null
          createdEntry.loadNumber += 1
          publish(id, createdEntry.blocked ? 'blocked' : 'error')
        }
      )
    }
    if (!entry.attached) {
      window.contentView.addChildView(entry.handle.view)
      entry.attached = true
      setBounds(entry.handle.view)
    }
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
    disposeAccount,
    async readWebIdentity(id, signal) {
      const accountExists = (): boolean =>
        accountStore.getState().accounts.some((account) => account.id === id)
      if (!accountExists()) return { accountExists: false, emailAddress: null }
      const identity = await identityReader.read(id, signal)
      if (!accountExists()) return { accountExists: false, emailAddress: null }
      return identity ?? { accountExists: true, emailAddress: null }
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      activeAccountId = null
      await Promise.all([...views.keys()].map((id) => disposeAccount(id)))
    }
  }
}
