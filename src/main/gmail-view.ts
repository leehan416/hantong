import {
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'
import { classifyGmailNavigation } from './gmail-navigation'
import { sanitizeNavigationDiagnostic } from './navigation-diagnostic'
import type { NavigationDiagnostic } from './navigation-diagnostic'

interface GmailViewCallbacks {
  openExternal: (url: string) => Promise<void>
  onNavigationBlocked: (diagnostic: NavigationDiagnostic) => void
  onMainFrameNavigation: (url: string) => void
  isMailAccessAllowed: () => boolean
}

interface GmailView {
  view: WebContentsView
  load: () => Promise<void>
  revokeMailAccess: () => void
  dispose: () => Promise<void>
}

function destroyWebContents(contents: WebContents, destroy: () => void): Promise<void> {
  if (contents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onDestroyed = (): void => resolve()
    contents.once('destroyed', onDestroyed)
    try {
      destroy()
      if (contents.isDestroyed()) resolve()
    } catch (error) {
      contents.removeListener('destroyed', onDestroyed)
      reject(error)
    }
  })
}

// The caller supplies a dedicated account session, never the local UI session.
export function createGmailView(webSession: Session, callbacks: GmailViewCallbacks): GmailView {
  const webPreferences: WebPreferences = {
    session: webSession,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false
  }
  const view = new WebContentsView({ webPreferences })
  const children = new Set<BrowserWindow>()
  const pendingPopupRecovery: boolean[] = []
  let disposed = false
  let disposePromise: Promise<void> | null = null

  webSession.setPermissionCheckHandler(() => false)
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  function openExternal(url: string, context: 'main' | 'popup', revealHost: boolean): void {
    void callbacks
      .openExternal(url)
      .catch(() =>
        callbacks.onNavigationBlocked(
          sanitizeNavigationDiagnostic(
            'external_open_failure',
            context,
            url,
            'external_redirect',
            revealHost
          )
        )
      )
  }

  function reportBlocked(
    source: 'redirect' | 'navigation' | 'popup',
    context: 'main' | 'popup',
    url: string,
    reason: 'external_redirect' | 'oauth_endpoint' | 'unsafe_url' | 'mail_access_denied'
  ): void {
    callbacks.onNavigationBlocked(sanitizeNavigationDiagnostic(source, context, url, reason))
  }

  function guard(
    contents: WebContents,
    child = false,
    authPopup?: { recoverAfterClose: boolean; visitedAuthHost: boolean }
  ): void {
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) return
      const target = classifyGmailNavigation(event.url)
      if (child && authPopup?.recoverAfterClose && isGoogleAuthUrl(event.url))
        authPopup.visitedAuthHost = true
      if (!child && target === 'internal') callbacks.onMainFrameNavigation(event.url)
      if (child && !callbacks.isMailAccessAllowed() && isMailUrl(event.url)) {
        event.preventDefault()
        return
      }
      if (target === 'internal') return
      event.preventDefault()
      if (target === 'external') openExternal(event.url, child ? 'popup' : 'main', true)
      else
        reportBlocked(
          'navigation',
          child ? 'popup' : 'main',
          event.url,
          navigationReason(event.url)
        )
    })
    contents.on('will-redirect', (event) => {
      const target = classifyGmailNavigation(event.url)
      if (child && authPopup?.recoverAfterClose && isGoogleAuthUrl(event.url))
        authPopup.visitedAuthHost = true
      if (event.isMainFrame && !child && target === 'internal')
        callbacks.onMainFrameNavigation(event.url)
      if (event.isMainFrame && child && !callbacks.isMailAccessAllowed() && isMailUrl(event.url)) {
        event.preventDefault()
        reportBlocked('redirect', 'popup', event.url, 'mail_access_denied')
        return
      }
      if (event.isMainFrame && target !== 'internal') {
        // Redirects must not launch an application without a new user action.
        event.preventDefault()
        reportBlocked(
          'redirect',
          child ? 'popup' : 'main',
          event.url,
          target === 'external' ? 'external_redirect' : navigationReason(event.url)
        )
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      const target = classifyGmailNavigation(url)
      if (target === 'external') {
        openExternal(url, child ? 'popup' : 'main', false)
        return { action: 'deny' }
      }
      const lockedGoogleSignIn =
        !callbacks.isMailAccessAllowed() && target === 'internal' && isGoogleAuthUrl(url)
      if (!callbacks.isMailAccessAllowed() && !lockedGoogleSignIn) {
        reportBlocked(
          'popup',
          child ? 'popup' : 'main',
          url,
          isMailUrl(url)
            ? 'mail_access_denied'
            : isGoogleOAuthUrl(url)
              ? 'oauth_endpoint'
              : 'unsafe_url'
        )
        return { action: 'deny' }
      }
      if (target === 'internal') {
        pendingPopupRecovery.push(lockedGoogleSignIn)
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: { webPreferences }
        }
      }
      reportBlocked('popup', child ? 'popup' : 'main', url, navigationReason(url))
      return { action: 'deny' }
    })
    contents.on('did-create-window', (child, details) => {
      children.add(child)
      const recoverAfterAuthClose = pendingPopupRecovery.shift() ?? false
      const authPopup = {
        recoverAfterClose: recoverAfterAuthClose,
        visitedAuthHost: recoverAfterAuthClose && isGoogleAuthUrl(details.url)
      }
      guard(child.webContents, true, authPopup)
      child.once('closed', () => {
        children.delete(child)
        if (
          authPopup.recoverAfterClose &&
          authPopup.visitedAuthHost &&
          !disposed &&
          !view.webContents.isDestroyed()
        ) {
          view.webContents.reload()
        }
      })
    })
  }

  guard(view.webContents)

  return {
    view,
    revokeMailAccess(): void {
      for (const child of children) {
        if (!child.isDestroyed()) child.destroy()
      }
      children.clear()
    },
    load(): Promise<void> {
      if (disposed || view.webContents.isDestroyed()) {
        return Promise.reject(new Error('Gmail view is unavailable'))
      }
      return view.webContents.loadURL('https://mail.google.com/')
    },
    dispose(): Promise<void> {
      if (disposePromise) return disposePromise
      disposed = true
      const attempt = (async (): Promise<void> => {
        await Promise.all(
          [...children].map((child) =>
            destroyWebContents(child.webContents, () => {
              if (!child.isDestroyed()) child.destroy()
            })
          )
        )
        children.clear()
        // Detaching a WebContentsView does not release its renderer process.
        await destroyWebContents(view.webContents, () => {
          view.webContents.close({ waitForBeforeUnload: false })
        })
      })()
      disposePromise = attempt.catch((error: unknown) => {
        disposePromise = null
        throw error
      })
      return disposePromise
    }
  }
}

function isMailUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'mail.google.com' && url.port === ''
  } catch {
    return false
  }
}

function isGoogleAuthUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === 'accounts.google.com' && url.port === ''
  } catch {
    return false
  }
}

function isGoogleOAuthUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'accounts.google.com' &&
      /^\/o\/oauth2(?:\/|$)/.test(url.pathname)
    )
  } catch {
    return false
  }
}

function navigationReason(value: string): 'oauth_endpoint' | 'unsafe_url' {
  return isGoogleOAuthUrl(value) ? 'oauth_endpoint' : 'unsafe_url'
}
