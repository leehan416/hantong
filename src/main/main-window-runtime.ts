import { app, BrowserWindow, screen } from 'electron'
import { createAccountViewManager } from './account-view-manager'
import { createAccountAccessController } from './account-access-controller'
import { createGoogleConnectionRuntime } from './google-connection-runtime'
import { createGoogleConnectionManager } from './google-connection-manager'
import { createAccountStore } from './account-store'
import { createSettingsStore } from './settings-store'
import { createWindowStateStore, fitWindowBounds } from './window-state'
import { fetchGoogleProfileEmail } from './google-token-exchange'
import { isTrustedRendererUrl } from './security-policy'
import { optimizer } from '@electron-toolkit/utils'
import { ACCOUNT_ACCESS_STATE_EVENT, ACCOUNT_VIEW_STATUS_EVENT } from '../shared/ipc'
import type { AccountState } from '../shared/accounts'
import type { GoogleWebIdentityFailureReason } from './google-web-identity'
import type { GmailViewLoadDiagnostic } from './account-view-lifecycle'
import type { NavigationDiagnostic } from './navigation-diagnostic'
import type { createNotificationRecoveryRuntime } from './notification-recovery-runtime'
import type { loadRuntimeGoogleOAuthConfig } from './google-oauth-runtime-config'

type ViewManager = ReturnType<typeof createAccountViewManager>
type AccessController = ReturnType<typeof createAccountAccessController>

export interface MainWindowRuntimeDependencies {
  readonly rendererUrl: string
  readonly preloadFile: string
  readonly window: () => BrowserWindow | null
  readonly setWindow: (window: BrowserWindow | null, current: BrowserWindow) => void
  readonly views: () => ViewManager | null
  readonly setViews: (views: ViewManager | null, current: ViewManager) => void
  readonly accessController: () => AccessController | null
  readonly setAccessController: (
    controller: AccessController | null,
    current: AccessController | null
  ) => void
  readonly googleRuntime: () => ReturnType<typeof createGoogleConnectionRuntime> | null
  readonly requireAccountStore: () => ReturnType<typeof createAccountStore>
  readonly requireGoogleRuntime: () => ReturnType<typeof createGoogleConnectionRuntime>
  readonly requireGoogleManager: () => ReturnType<typeof createGoogleConnectionManager>
  readonly settings: () => ReturnType<typeof createSettingsStore> | null
  readonly windowState: () => ReturnType<typeof createWindowStateStore> | null
  readonly isQuitting: () => boolean
  readonly recovery: ReturnType<typeof createNotificationRecoveryRuntime>
  readonly notificationController: () => { flushAlerts: () => void } | null
  readonly loadGoogleConfig: () => ReturnType<typeof loadRuntimeGoogleOAuthConfig>
  readonly publishAccountState: (owner: BrowserWindow, state: AccountState) => void
  readonly openExternal: (url: string) => Promise<void>
  readonly openValidatedExternal: (url: string) => void
  readonly reportIdentityDiagnostic: (
    reason: GoogleWebIdentityFailureReason,
    accountId: string
  ) => void
  readonly reportViewLoadDiagnostic: (
    accountId: string,
    diagnostic: GmailViewLoadDiagnostic
  ) => void
  readonly reportNavigationDiagnostic: (accountId: string, diagnostic: NavigationDiagnostic) => void
}

export function createMainWindowRuntime(dependencies: MainWindowRuntimeDependencies): {
  create(): void
} {
  function create(): void {
    const saved = dependencies.windowState()?.read() ?? null
    const bounds = saved
      ? fitWindowBounds(
          saved.bounds,
          screen.getAllDisplays().map((display) => display.workArea)
        )
      : null
    const window = new BrowserWindow({
      title: 'Hantong',
      ...(bounds ?? { width: 1000, height: 720 }),
      minWidth: 640,
      minHeight: 480,
      show: false,
      webPreferences: {
        preload: dependencies.preloadFile,
        partition: 'hantong-ui',
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false
      }
    })
    dependencies.setWindow(window, window)
    if (bounds && saved?.maximized) window.maximize()
    window.on('close', (event) => {
      dependencies
        .windowState()
        ?.write({ bounds: window.getNormalBounds(), maximized: window.isMaximized() })
      for (const accountId of dependencies.recovery.pendingAccountIds()) {
        dependencies.recovery.clearPending(accountId)
        const runtime = dependencies.googleRuntime()
        void runtime?.cancel(accountId).catch(() => undefined)
      }
      // Hiding keeps Main, the relay stream and notifications alive; quitting goes through before-quit.
      if (
        !dependencies.isQuitting() &&
        (dependencies.settings()?.get().closeAction ?? 'hide') === 'hide'
      ) {
        event.preventDefault()
        if (window.isFullScreen()) window.setFullScreen(false)
        window.hide()
        // Hidden means menu-bar only; the tray keeps the unread count the Dock badge showed.
        app.dock?.hide()
      }
    })
    // Every reopen path (tray, notification, second instance, activate) goes through show.
    window.on('show', () => {
      app.dock?.show().catch(() => {
        console.error('Unable to show the Dock icon')
      })
      dependencies.notificationController()?.flushAlerts()
    })
    let windowAccessController: AccessController | null = null
    const windowViewManager = createAccountViewManager(
      window,
      dependencies.requireAccountStore(),
      (status) => {
        if (!window.isDestroyed()) window.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, status)
        const activeId = windowViewManager.getActiveAccountId()
        if (activeId === status.accountId) {
          for (const pendingId of dependencies.recovery.pendingAccountIds()) {
            if (pendingId !== activeId) {
              dependencies.recovery.clearPending(pendingId)
              const runtime = dependencies.googleRuntime()
              void runtime?.cancel(pendingId).catch(() => undefined)
            }
          }
        }
        if (status.status === 'blocked' || status.status === 'error') {
          if (dependencies.recovery.hasPending(status.accountId))
            dependencies.recovery.failPending(
              status.accountId,
              new Error('The Gmail identity is not ready for recovery')
            )
        }
        if (
          status.status === 'ready' ||
          status.status === 'blocked' ||
          status.status === 'error' ||
          status.status === 'loading'
        ) {
          if (!dependencies.recovery.hasPending(status.accountId)) {
            windowAccessController?.onViewReady(status.accountId)
          }
        }
        if (status.status === 'ready' && dependencies.recovery.hasPending(status.accountId)) {
          const id = status.accountId
          if (windowViewManager.getActiveAccountId() === id) dependencies.recovery.startPending(id)
        }
      },
      dependencies.openExternal,
      30_000,
      dependencies.reportIdentityDiagnostic,
      dependencies.reportViewLoadDiagnostic,
      dependencies.reportNavigationDiagnostic
    )
    dependencies.setViews(windowViewManager, windowViewManager)
    const savedSettings = dependencies.settings()?.get()
    windowViewManager.setLayout(
      savedSettings?.accountSelectorPosition ?? 'top',
      savedSettings?.sidebarCollapsed ?? false
    )
    windowAccessController = createAccountAccessController({
      views: windowViewManager,
      runtime: dependencies.requireGoogleRuntime(),
      connections: dependencies.requireGoogleManager(),
      loadConfig: dependencies.loadGoogleConfig,
      fetchProfile: async (accessToken, signal) => {
        const email = await fetchGoogleProfileEmail(accessToken, { fetch, signal })
        if (!email) throw new Error('Google profile is unavailable')
        return email
      },
      accountExists: (id) =>
        dependencies
          .requireAccountStore()
          .getState()
          .accounts.some((account) => account.id === id),
      publish: (state) => {
        if (!window.isDestroyed()) window.webContents.send(ACCOUNT_ACCESS_STATE_EVENT, state)
      },
      onWebIdentity: (accountId, emailAddress) => {
        try {
          const store = dependencies.requireAccountStore()
          if (
            store.getState().accounts.find((account) => account.id === accountId)?.email ===
            emailAddress
          )
            return
          const state = store.recordWebIdentityEmail(accountId, emailAddress)
          dependencies.publishAccountState(window, state)
        } catch {
          // Identity persistence must not block mailbox access; never log the account email.
          console.error('Unable to save Gmail web identity')
        }
      }
    })
    dependencies.setAccessController(windowAccessController, windowAccessController)

    const contents = window.webContents
    contents.session.setPermissionCheckHandler(() => false)
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false)
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
    contents.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame || !isTrustedRendererUrl(event.url, dependencies.rendererUrl)) {
        event.preventDefault()
      }
    })
    contents.on('will-redirect', (event) => {
      if (!isTrustedRendererUrl(event.url, dependencies.rendererUrl)) event.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      dependencies.openValidatedExternal(url)
      return { action: 'deny' }
    })

    window.once('ready-to-show', () => window.show())
    window.once('closed', () => {
      if (!dependencies.isQuitting() && dependencies.settings()?.get().closeAction === 'quit')
        app.quit()
      void dependencies
        .googleRuntime()
        ?.cancelAll()
        .catch(() => {
          console.error('Unable to cancel pending Google connections')
        })
      void windowViewManager.dispose().catch(() => {
        console.error('Unable to close Gmail views')
      })
      windowAccessController?.dispose()
      dependencies.setAccessController(null, windowAccessController)
      dependencies.setViews(null, windowViewManager)
      dependencies.setWindow(null, window)
    })
    optimizer.watchWindowShortcuts(window)

    void contents.loadURL(dependencies.rendererUrl).catch(() => {
      console.error('Unable to load the Hantong window')
      window.destroy()
      app.quit()
    })
  }

  return { create }
}
