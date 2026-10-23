import type { ViewEntry } from './account-view-types'
import { classifyGmailNavigation } from './gmail-navigation'
import { isAllowedGmailIdentityUrl } from './google-web-identity'

type DocumentKind = 'sign_in' | 'mail' | 'unknown'

interface AccountViewLifecycleOptions {
  loadTimeoutMs: number
  isAlive: () => boolean
  isCurrent: (id: string, entry: ViewEntry) => boolean
  isActive: (id: string) => boolean
  publish: (id: string, status: 'loading' | 'ready' | 'blocked' | 'error') => void
  reconcileVisibility: (id: string, entry: ViewEntry) => void
}

export function createAccountViewLifecycle({
  loadTimeoutMs,
  isAlive,
  isCurrent,
  isActive,
  publish,
  reconcileVisibility
}: AccountViewLifecycleOptions): {
  documentKind: (value: string) => DocumentKind
  load: (id: string, entry: ViewEntry) => void
  retry: (id: string, entry: ViewEntry) => void
  register: (id: string, entry: ViewEntry) => void
  invalidate: (entry: ViewEntry) => void
} {
  function documentKind(value: string): DocumentKind {
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

  function armLoadTimeout(id: string, entry: ViewEntry, loadNumber: number): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = setTimeout(() => {
      entry.timeout = null
      if (entry.loadNumber !== loadNumber) return
      entry.loadNumber += 1
      entry.loading = false
      entry.loaded = false
      entry.mainFrameNavigationPending = false
      entry.pendingMainFrameKind = null
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
      !isAlive() ||
      entry.disposePromise ||
      !isCurrent(id, entry) ||
      !entry.mainFrameNavigationPending ||
      !entry.mainFrameDocumentLoaded ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame()
    )
      return
    entry.mainFrameNavigationPending = false
    entry.pendingMainFrameKind = null
    entry.mainFrameDocumentLoaded = false
    entry.loaded = true
    entry.loading = false
    entry.committedUrl = contents.getURL()
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = null
    entry.loadNumber += 1
    reconcileVisibility(id, entry)
    if (isAllowedGmailIdentityUrl(contents.getURL())) entry.blocked = false
    if (isActive(id)) publish(id, entry.blocked ? 'blocked' : 'ready')
  }

  function load(id: string, entry: ViewEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    const loadNumber = ++entry.loadNumber
    const navigationRevision = entry.navigationRevision
    entry.blocked = false
    entry.loaded = false
    entry.loading = true
    entry.mainFrameNavigationPending = false
    entry.pendingMainFrameKind = null
    publish(id, 'loading')
    entry.mainFrameDocumentLoaded = false
    armLoadTimeout(id, entry, loadNumber)
    void entry.handle.load().then(
      () => {
        if (entry.loadNumber !== loadNumber || entry.navigationRevision !== navigationRevision)
          return
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        if (!isAlive()) return
        entry.loaded = true
        entry.loading = false
        entry.committedUrl = entry.handle.view.webContents.getURL()
        reconcileVisibility(id, entry)
        if (isActive(id)) publish(id, entry.blocked ? 'blocked' : 'ready')
      },
      () => {
        if (entry.loadNumber !== loadNumber || entry.navigationRevision !== navigationRevision)
          return
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        if (isAlive()) {
          entry.loading = false
          publish(id, entry.blocked ? 'blocked' : 'error')
        }
      }
    )
  }

  function register(id: string, entry: ViewEntry): void {
    const view = entry.handle.view
    view.webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || !isAlive() || entry.disposePromise || !isCurrent(id, entry))
        return
      entry.navigationRevision += 1
      if (details.isSameDocument) {
        let accountSlotChanged = false
        try {
          const current = new URL(entry.committedUrl)
          const next = new URL(details.url)
          const currentSlot = current.pathname.match(/^\/mail\/u\/(\d+)(?:\/|$)/)?.[1]
          const nextSlot = next.pathname.match(/^\/mail\/u\/(\d+)(?:\/|$)/)?.[1]
          if (currentSlot && nextSlot && currentSlot !== nextSlot) {
            accountSlotChanged = true
            entry.accessRevision += 1
            entry.mailAccessGranted = false
            entry.handle.revokeMailAccess()
            reconcileVisibility(id, entry)
          }
          entry.committedUrl = details.url
        } catch {
          entry.accessRevision += 1
          entry.mailAccessGranted = false
          entry.handle.revokeMailAccess()
          reconcileVisibility(id, entry)
        }
        if (accountSlotChanged && isActive(id)) publish(id, 'ready')
        return
      }
      entry.accessRevision += 1
      entry.mailAccessGranted = false
      entry.handle.revokeMailAccess()
      entry.loadNumber += 1
      entry.mainFrameNavigationPending = true
      entry.pendingMainFrameKind = documentKind(details.url)
      entry.mainFrameDocumentLoaded = false
      entry.loaded = false
      entry.loading = true
      reconcileVisibility(id, entry)
      armLoadTimeout(id, entry, entry.loadNumber)
      publish(id, 'loading')
    })
    view.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
      const contents = view.webContents
      if (!isMainFrame || !entry.mainFrameNavigationPending || contents.isDestroyed()) return
      entry.mainFrameDocumentLoaded = true
      finishSuccessfulMainFrameNavigation(id, entry)
    })
    view.webContents.on('did-stop-loading', () => {
      finishSuccessfulMainFrameNavigation(id, entry)
    })
    view.webContents.on('render-process-gone', () => {
      if (entry.timeout) clearTimeout(entry.timeout)
      entry.timeout = null
      entry.loadNumber += 1
      entry.loaded = false
      entry.loading = false
      entry.mainFrameNavigationPending = false
      entry.pendingMainFrameKind = null
      entry.mainFrameDocumentLoaded = false
      entry.navigationRevision += 1
      entry.accessRevision += 1
      entry.mailAccessGranted = false
      entry.handle.revokeMailAccess()
      reconcileVisibility(id, entry)
      if (isAlive()) publish(id, 'error')
    })
    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, _description, validatedUrl, isMainFrame) => {
        const contents = view.webContents
        if (
          !isMainFrame ||
          errorCode === -3 ||
          !isAlive() ||
          entry.disposePromise ||
          !isCurrent(id, entry) ||
          contents.isDestroyed() ||
          contents.isLoadingMainFrame() ||
          contents.getURL() !== validatedUrl
        )
          return
        entry.loaded = false
        entry.loading = false
        entry.mainFrameNavigationPending = false
        entry.pendingMainFrameKind = null
        entry.mainFrameDocumentLoaded = false
        entry.accessRevision += 1
        entry.mailAccessGranted = false
        entry.handle.revokeMailAccess()
        reconcileVisibility(id, entry)
        if (entry.timeout) clearTimeout(entry.timeout)
        entry.timeout = null
        entry.loadNumber += 1
        publish(id, entry.blocked ? 'blocked' : 'error')
      }
    )
  }

  function invalidate(entry: ViewEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout)
    entry.timeout = null
    entry.navigationRevision += 1
    entry.loadNumber += 1
    entry.loaded = false
    entry.loading = false
    entry.mainFrameNavigationPending = false
    entry.pendingMainFrameKind = null
    entry.mainFrameDocumentLoaded = false
  }

  function retry(id: string, entry: ViewEntry): void {
    load(id, entry)
  }

  return { documentKind, load, retry, register, invalidate }
}
