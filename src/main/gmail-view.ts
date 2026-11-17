import {
  app,
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
  onLogoutRequestStart?: (requestId: number) => LogoutRequestStartDecision | void
  onLogoutRequestSuccess?: (requestId: number) => LogoutRequestSuccessDecision | void
  onLogoutRequestFailure?: (requestId: number) => void
  onLogoutTerminalRedirect?: () => boolean
}

export type LogoutRequestStartDecision =
  | 'accepted'
  | 'already_confirmed'
  | 'account_missing'
  | 'disposed'
  | 'not_established'
  | 'request_pending'
  | 'stale_view'

export type LogoutRequestSuccessDecision = 'confirmed' | 'awaiting_ready_sign_in' | 'stale_request'

interface GmailView {
  view: WebContentsView
  load: () => Promise<void>
  revokeMailAccess: () => void
  dispose: () => Promise<void>
}

interface LogoutProbeRecord {
  event: 'start' | 'redirect' | 'completed' | 'error'
  route: 'accounts_logout_candidate_unverified' | 'mail_logout_candidate_unverified'
  requestId: number
  resourceType: string
  statusCode?: number
  redirectTarget?: 'google_signin' | 'gmail' | 'logout_candidate' | 'other'
  ownerContext: 'view_main' | 'popup' | 'other'
  observed?: boolean
  decision?:
    | LogoutRequestStartDecision
    | LogoutRequestSuccessDecision
    | 'request_error'
    | 'http_failure'
    | 'not_main_frame'
    | 'not_owner_main_frame'
    | 'untracked'
    | 'unsupported_route'
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
export function createGmailView(
  webSession: Session,
  callbacks: GmailViewCallbacks,
  options: {
    enableLogoutProbe?: boolean
    reportLogoutProbe?: (record: LogoutProbeRecord) => void
  } = {}
): GmailView {
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
  const removeLogoutProbeListeners: Array<() => void> = []

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
        let acceptedLogoutRedirect = false
        if (!child && target === 'external' && isWorkspaceTerminalRedirect(event.url)) {
          try {
            acceptedLogoutRedirect = callbacks.onLogoutTerminalRedirect?.() === true
          } catch {
            // A terminal-evidence observer must not interrupt the navigation guard.
          }
        }
        if (acceptedLogoutRedirect) return
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

  {
    // Account sessions are dedicated to Gmail; Electron allows one webRequest listener per event.
    const requestFilter = {
      urls: ['https://accounts.google.com/*', 'https://mail.google.com/*']
    }
    const webRequest = webSession.webRequest
    const logoutRequests = new Set<number>()
    const ownerContext = (webContentsId: number | undefined): LogoutProbeRecord['ownerContext'] => {
      if (webContentsId === view.webContents.id) return 'view_main'
      if ([...children].some((child) => child.webContents.id === webContentsId)) return 'popup'
      return 'other'
    }
    const reportProbe = (
      event: 'start' | 'redirect' | 'completed' | 'error',
      details: {
        id: number
        url: string
        resourceType: string
        webContentsId?: number
        statusCode?: number
        redirectURL?: string
      },
      decision?: LogoutProbeRecord['decision'],
      observed?: boolean
    ): void => {
      if (disposed || app.isPackaged || options.enableLogoutProbe === false) return
      const route = classifyLogoutCandidate(details.url)
      if (!route) return
      const resourceType = safeResourceType(details.resourceType)
      const statusCode = Number.isInteger(details.statusCode) ? details.statusCode : undefined
      try {
        const record: LogoutProbeRecord = {
          event,
          route,
          requestId: details.id,
          resourceType,
          ownerContext: ownerContext(details.webContentsId),
          ...(decision ? { decision } : {}),
          ...(observed === undefined ? {} : { observed }),
          ...(event === 'redirect'
            ? { redirectTarget: classifyRedirectTarget(details.redirectURL) }
            : {}),
          ...(statusCode === undefined ? {} : { statusCode })
        }
        if (options.reportLogoutProbe) options.reportLogoutProbe(record)
        else console.info('[gmail-logout-probe]', record)
      } catch {
        // Diagnostics must never affect Gmail requests.
      }
    }
    webRequest.onBeforeRequest(requestFilter, (details, callback) => {
      try {
        const route = classifyLogoutCandidate(details.url)
        const owner = ownerContext(details.webContentsId)
        let decision: LogoutProbeRecord['decision'] = 'unsupported_route'
        if (route === 'accounts_logout_candidate_unverified') {
          if (disposed) decision = 'disposed'
          else if (details.resourceType !== 'mainFrame') decision = 'not_main_frame'
          else if (owner !== 'view_main') decision = 'not_owner_main_frame'
          else {
            try {
              decision = callbacks.onLogoutRequestStart?.(details.id) ?? 'stale_view'
            } catch {
              decision = 'stale_view'
            }
          }
        }
        if (
          route === 'accounts_logout_candidate_unverified' &&
          details.resourceType === 'mainFrame' &&
          owner === 'view_main' &&
          !disposed
        ) {
          logoutRequests.add(details.id)
        }
        reportProbe('start', details, decision)
      } finally {
        callback({})
      }
    })
    webRequest.onBeforeRedirect(requestFilter, (details) =>
      reportProbe('redirect', details, 'untracked')
    )
    webRequest.onCompleted(requestFilter, (details) => {
      const observed = logoutRequests.delete(details.id)
      let decision: LogoutProbeRecord['decision'] = 'untracked'
      const ownerMatches =
        details.webContentsId === undefined || details.webContentsId === view.webContents.id
      if (observed && !disposed && ownerMatches) {
        try {
          if (details.resourceType === 'mainFrame' && details.statusCode === 200)
            decision = callbacks.onLogoutRequestSuccess?.(details.id) ?? 'awaiting_ready_sign_in'
          else {
            callbacks.onLogoutRequestFailure?.(details.id)
            decision = 'http_failure'
          }
        } catch {
          // Logout observation must never affect the browser request.
        }
      } else if (observed && !ownerMatches) decision = 'not_owner_main_frame'
      reportProbe('completed', details, decision, observed)
    })
    webRequest.onErrorOccurred(requestFilter, (details) => {
      const observed = logoutRequests.delete(details.id)
      if (observed && !disposed) {
        try {
          callbacks.onLogoutRequestFailure?.(details.id)
        } catch {
          // Logout observation must never affect the browser request.
        }
      }
      reportProbe('error', details, observed ? 'request_error' : 'untracked', observed)
    })
    removeLogoutProbeListeners.push(
      () => webRequest.onBeforeRequest(requestFilter, null),
      () => webRequest.onBeforeRedirect(requestFilter, null),
      () => webRequest.onCompleted(requestFilter, null),
      () => webRequest.onErrorOccurred(requestFilter, null)
    )
  }

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
        for (const removeListener of removeLogoutProbeListeners) removeListener()
        removeLogoutProbeListeners.length = 0
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

function isWorkspaceTerminalRedirect(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'workspace.google.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

function classifyLogoutCandidate(
  value: string
): 'accounts_logout_candidate_unverified' | 'mail_logout_candidate_unverified' | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '')
      return null
    if (url.hostname === 'accounts.google.com' && url.pathname === '/Logout')
      return 'accounts_logout_candidate_unverified'
    if (url.hostname === 'mail.google.com' && url.pathname === '/mail/logout')
      return 'mail_logout_candidate_unverified'
    return null
  } catch {
    return null
  }
}

function classifyRedirectTarget(
  value: string | undefined
): 'google_signin' | 'gmail' | 'logout_candidate' | 'other' {
  if (!value) return 'other'
  if (classifyLogoutCandidate(value)) return 'logout_candidate'
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port !== '') return 'other'
    if (url.hostname === 'accounts.google.com') return 'google_signin'
    if (url.hostname === 'mail.google.com') return 'gmail'
    return 'other'
  } catch {
    return 'other'
  }
}

function safeResourceType(value: string): string {
  const allowed = new Set([
    'mainFrame',
    'subFrame',
    'stylesheet',
    'script',
    'image',
    'font',
    'object',
    'xhr',
    'ping',
    'cspReport',
    'media',
    'webSocket',
    'other'
  ])
  return allowed.has(value) ? value : 'other'
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
