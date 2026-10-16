import {
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents,
  type WebPreferences
} from 'electron'
import { classifyGmailNavigation } from './gmail-navigation'

interface GmailViewCallbacks {
  openExternal: (url: string) => Promise<void>
  onNavigationBlocked: () => void
}

interface GmailView {
  view: WebContentsView
  load: () => Promise<void>
  dispose: () => void
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
  let disposed = false

  webSession.setPermissionCheckHandler(() => false)
  webSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))

  function openExternal(url: string): void {
    void callbacks.openExternal(url).catch(callbacks.onNavigationBlocked)
  }

  function guard(contents: WebContents): void {
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) return
      const target = classifyGmailNavigation(event.url)
      if (target === 'internal') return
      event.preventDefault()
      if (target === 'external') openExternal(event.url)
      else callbacks.onNavigationBlocked()
    })
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && classifyGmailNavigation(event.url) !== 'internal') {
        // Redirects must not launch an application without a new user action.
        event.preventDefault()
        callbacks.onNavigationBlocked()
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      const target = classifyGmailNavigation(url)
      if (target === 'internal') {
        return {
          action: 'allow',
          outlivesOpener: false,
          overrideBrowserWindowOptions: { webPreferences }
        }
      }
      if (target === 'external') openExternal(url)
      else callbacks.onNavigationBlocked()
      return { action: 'deny' }
    })
    contents.on('did-create-window', (child) => {
      children.add(child)
      guard(child.webContents)
      child.once('closed', () => children.delete(child))
    })
  }

  guard(view.webContents)

  return {
    view,
    load(): Promise<void> {
      if (disposed || view.webContents.isDestroyed()) {
        return Promise.reject(new Error('Gmail view is unavailable'))
      }
      return view.webContents.loadURL('https://mail.google.com/')
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const child of children) {
        if (!child.isDestroyed()) child.destroy()
      }
      children.clear()
      // Detaching a WebContentsView does not release its renderer process.
      if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
    }
  }
}
