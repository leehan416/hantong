import type { BrowserWindow, WebContentsView } from 'electron'
import type { AccountState } from '../shared/accounts'
import { ACCOUNT_CHROME_HEIGHT, type AccountViewStatus } from '../shared/ipc'
import { getAccountSession } from './account-session'
import { createGmailView } from './gmail-view'

interface AccountStore {
  getState: () => AccountState
}

interface ViewHandle {
  view: WebContentsView
  load: () => Promise<void>
  dispose: () => void
}

export function createAccountViewManager(
  window: BrowserWindow,
  accountStore: AccountStore,
  report: (status: AccountViewStatus) => void,
  openExternal: (url: string) => Promise<void>,
  loadTimeoutMs = 30_000
): { activate: (id: string) => void; retry: () => void; dispose: () => void } {
  const views = new Map<
    string,
    {
      handle: ViewHandle
      loaded: boolean
      loading: boolean
      attached: boolean
      blocked: boolean
      loadNumber: number
      timeout: ReturnType<typeof setTimeout> | null
    }
  >()
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

  window.on('resize', () => {
    const entry = activeAccountId ? views.get(activeAccountId) : undefined
    if (entry?.attached) setBounds(entry.handle.view)
  })

  function load(
    id: string,
    entry: {
      handle: ViewHandle
      loaded: boolean
      loading: boolean
      attached: boolean
      blocked: boolean
      loadNumber: number
      timeout: ReturnType<typeof setTimeout> | null
    }
  ): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    const loadNumber = ++entry.loadNumber
    entry.blocked = false
    entry.loaded = false
    entry.loading = true
    publish(id, 'loading')
    entry.timeout = setTimeout(() => {
      entry.timeout = null
      if (entry.loadNumber === loadNumber) {
        entry.loadNumber += 1
        entry.loading = false
        publish(id, 'error')
      }
    }, loadTimeoutMs)
    void entry.handle.load().then(
      () => {
        if (entry.loadNumber !== loadNumber) return
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        if (!alive()) return
        entry.loaded = true
        entry.loading = false
        if (activeAccountId === id) publish(id, entry.blocked ? 'blocked' : 'ready')
      },
      () => {
        if (entry.loadNumber !== loadNumber) return
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
        timeout: null
      }
      entry = createdEntry
      views.set(id, createdEntry)
      handle.view.webContents.on('render-process-gone', () => {
        if (createdEntry.timeout) clearTimeout(createdEntry.timeout)
        createdEntry.timeout = null
        createdEntry.loadNumber += 1
        createdEntry.loaded = false
        createdEntry.loading = false
        if (alive()) publish(id, 'error')
      })
      handle.view.webContents.on(
        'did-fail-load',
        (_event, errorCode, _description, _validatedUrl, isMainFrame) => {
          if (!isMainFrame || errorCode === -3) return
          createdEntry.loaded = false
          if (!createdEntry.loading && alive()) {
            publish(id, createdEntry.blocked ? 'blocked' : 'error')
          }
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
    if (!alive() || !activeAccountId) return
    const entry = views.get(activeAccountId)
    if (entry) load(activeAccountId, entry)
    else activate(activeAccountId)
  }

  return {
    activate,
    retry,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const { handle, attached, timeout } of views.values()) {
        if (timeout) clearTimeout(timeout)
        if (attached && !window.isDestroyed()) window.contentView.removeChildView(handle.view)
        handle.dispose()
      }
      views.clear()
      activeAccountId = null
    }
  }
}
