import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  dialog,
  nativeImage,
  Tray,
  nativeTheme,
  shell
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAccountStore } from './account-store'
import { createAccountViewManager } from './account-view-manager'
import { createAccountAccessController } from './account-access-controller'
import { createMainWindowRuntime } from './main-window-runtime'
import { registerMainIpc } from './main-ipc'
import { createAccountRemovalController } from './account-removal'
import { clearAccountSession } from './account-session-cleanup'
import { createGoogleConnectionManager } from './google-connection-manager'
import { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { GoogleConnectionFailureCode } from './google-connection'
import type { GoogleWebIdentityFailureReason } from './google-web-identity'
import { loadRuntimeGoogleOAuthConfig } from './google-oauth-runtime-config'
import { createRelayRuntime } from './relay-runtime'
import { createSettingsStore } from './settings-store'
import { buildAppMenuTemplate, buildContextMenuTemplate, buildTrayMenuTemplate } from './app-menu'
import trayIconPath from '../../resources/icon.png?asset'
import { createWindowStateStore } from './window-state'
import { createGmailCleanupRuntime } from './gmail-cleanup-runtime'
import { createAppUpdateRuntime } from './app-update-runtime'
import type { AccountState } from '../shared/accounts'
import { createGmailRelaySync } from './gmail-relay-sync'
import { createNotificationConnectionController } from './notification-connection-controller'
import { createMainDiagnostics, createRotatingDiagnosticsSink } from './main-diagnostics'
import { createNativeMailNotifications } from './native-mail-notifications'
import { createNotificationRecoveryRuntime } from './notification-recovery-runtime'
import { createMainMailRuntime } from './main-mail-runtime'
import type { AuthorizationErrorCode } from './google-authorization'
import { is } from '@electron-toolkit/utils'
import { ACCOUNT_STATE_EVENT, SETTINGS_OPEN_EVENT, ACCOUNT_VIEW_STATUS_EVENT } from '../shared/ipc'
import { isAllowedExternalUrl } from './security-policy'
import { createNotificationPauseStore } from './notification-pause-store'
import { createLoginLaunchController } from './login-launch'
import { createLoginLaunchStartupController } from './login-launch-startup'
import {
  createNotificationPauseController,
  createNotificationPauseMenuActions
} from './notification-pause'

app.setName('Hantong')

// A second launch only brings the running instance forward (see 'second-instance' below).
if (!app.requestSingleInstanceLock()) app.exit(0)

// Injected by electron.vite.config.ts at build time.
declare const __HANTONG_BUNDLED_ENV__: Record<string, string | undefined>

const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(rendererFile).href

let mainWindow: BrowserWindow | null = null
let accountStore: ReturnType<typeof createAccountStore> | null = null
let settingsStore: ReturnType<typeof createSettingsStore> | null = null
let notificationPauseController: ReturnType<typeof createNotificationPauseController> | null = null
let windowStateStore: ReturnType<typeof createWindowStateStore> | null = null
let tray: Tray | null = null
let accountViewManager: ReturnType<typeof createAccountViewManager> | null = null
let accountRemoval: ReturnType<typeof createAccountRemovalController> | null = null
let googleConnectionRuntime: ReturnType<typeof createGoogleConnectionRuntime> | null = null
let googleConnectionManager: ReturnType<typeof createGoogleConnectionManager> | null = null
let relayRuntime: ReturnType<typeof createRelayRuntime> | null = null
let gmailRelaySync: ReturnType<typeof createGmailRelaySync> | null = null
let accountAccessController: ReturnType<typeof createAccountAccessController> | null = null
let notificationConnectionController: ReturnType<
  typeof createNotificationConnectionController
> | null = null
let appQuitting = false
let quitCleanupPending = false
let quitCleanupComplete = false
let updateRuntime: ReturnType<typeof createAppUpdateRuntime> | null = null
let fallbackSync: ReturnType<typeof setInterval> | undefined
let cleanupPromise: Promise<void> | undefined
let wasOpenedAtLogin = false

const notificationRecoveryRuntime = createNotificationRecoveryRuntime({
  window: () => mainWindow,
  googleRuntime: () => googleConnectionRuntime,
  views: () => accountViewManager,
  accessController: () => accountAccessController,
  notificationController: () => notificationConnectionController,
  accountRemoval: () => accountRemoval,
  accountStore: () => accountStore,
  isQuitting: () => appQuitting,
  locale: uiLocale,
  showAccount
})
const loginLaunch = createLoginLaunchController({
  supported: process.platform === 'darwin' && app.isPackaged,
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings)
})

function prepareApplicationShutdown(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  if (fallbackSync) clearInterval(fallbackSync)
  gmailRelaySync?.dispose()
  notificationConnectionController?.dispose()
  notificationPauseController?.dispose()
  notificationRecoveryRuntime.resolveAll()
  const cleanup = Promise.all([
    googleConnectionRuntime?.cancelAll() ?? Promise.resolve(),
    relayRuntime?.dispose() ?? Promise.resolve()
  ]).then(() => undefined)
  let timeout: ReturnType<typeof setTimeout> | undefined
  cleanupPromise = Promise.race([
    cleanup,
    new Promise<void>((resolve) => (timeout = setTimeout(resolve, 2000)))
  ]).finally(() => clearTimeout(timeout))
  cleanupPromise = cleanupPromise.catch((error: unknown) => {
    cleanupPromise = undefined
    throw error
  })
  return cleanupPromise
}

function reportOAuthDiagnostic(
  stage: 'config' | 'connection' | 'persistence' | 'identity' | 'authorization',
  code:
    | Exclude<GoogleConnectionFailureCode, 'cancelled'>
    | GoogleWebIdentityFailureReason
    | AuthorizationErrorCode
    | 'config_unavailable'
    | 'connection_start_failed'
    | 'connection_failed'
    | 'accept_failed'
): void {
  if (!app.isPackaged) console.error(`[Hantong OAuth] ${stage}:${code}`)
}

app.on('window-all-closed', () => {
  // macOS keeps the application available for reopening from the Dock.
})

function openExternal(url: string): void {
  if (!isAllowedExternalUrl(url)) return
  void shell.openExternal(url).catch(() => {
    // URLs can contain personal information; do not include them in diagnostics.
    console.error('Unable to open the external link')
  })
}

function createWindow(): void {
  mainWindowRuntime.create()
}

function requireAccountStore(): ReturnType<typeof createAccountStore> {
  if (!accountStore) throw new Error('Account store is unavailable')
  return accountStore
}

function requireAccountRemoval(): ReturnType<typeof createAccountRemovalController> {
  if (!accountRemoval) throw new Error('Account removal is unavailable')
  return accountRemoval
}

function requireGoogleConnectionRuntime(): NonNullable<typeof googleConnectionRuntime> {
  if (!googleConnectionRuntime) throw new Error('Google connection runtime is unavailable')
  return googleConnectionRuntime
}

function requireGoogleConnectionManager(): NonNullable<typeof googleConnectionManager> {
  if (!googleConnectionManager) throw new Error('Google connection manager is unavailable')
  return googleConnectionManager
}

// The language setting wins; 'system' follows the OS locale.
function uiLocale(): 'ko' | 'en' {
  const language = settingsStore?.get().language ?? 'system'
  if (language !== 'system') return language
  return app.getLocale().startsWith('ko') ? 'ko' : 'en'
}

function openSettings(): void {
  const window = mainWindow
  // ponytail: with no window yet the menu only creates one; reopen Cmd+, once it has loaded.
  if (!window || window.isDestroyed()) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.send(SETTINGS_OPEN_EVENT)
}

function showMainWindow(): void {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

const loginLaunchStartup = createLoginLaunchStartupController({
  showWindow: showMainWindow,
  hideDock: () => app.dock?.hide()
})

app.on('activate', () => loginLaunchStartup.requestReveal())

// Rebuilt whenever the language changes, so every Hantong-owned label follows the setting.
function installAppMenu(): void {
  const locale = uiLocale()
  const pauseController = notificationPauseController
  const pauseSnapshot = pauseController?.snapshot()
  const pauseActions = pauseController
    ? createNotificationPauseMenuActions(
        {
          pauseFor: (choice) => {
            if (appQuitting) return pauseController.snapshot()
            return pauseController.pauseFor(choice)
          },
          resumeNow: () => {
            if (appQuitting) return pauseController.snapshot()
            return pauseController.resumeNow()
          }
        },
        () => {
          if (appQuitting) return
          const message =
            uiLocale() === 'ko'
              ? '알림 일시 중지 설정을 저장하지 못했습니다.'
              : 'Could not save notification pause settings.'
          const options = {
            type: 'error' as const,
            title: uiLocale() === 'ko' ? '알림 설정 오류' : 'Notification settings error',
            message
          }
          const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
          const showError = parent
            ? dialog.showMessageBox(parent, options)
            : dialog.showMessageBox(options)
          void showError.catch(() => console.error('Unable to show notification pause error'))
        }
      )
    : null
  const notifications =
    pauseSnapshot && pauseActions ? { ...pauseSnapshot, ...pauseActions } : undefined
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppMenuTemplate(locale, {
        openSettings,
        ...(notifications ? { notifications } : {}),
        ...(updateRuntime
          ? {
              update: {
                state: updateRuntime.controller.state.kind,
                check: () => void updateRuntime?.controller.check(true),
                restart: () => void updateRuntime?.controller.restart()
              }
            }
          : {})
      })
    )
  )
  if (!tray) {
    // A small copy of the app icon; a monochrome template icon can replace it later.
    tray = new Tray(nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 }))
    tray.setToolTip('Hantong')
    tray.on('click', showMainWindow)
  }
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(locale, {
        open: showMainWindow,
        quit: () => app.quit(),
        ...(notifications ? { notifications } : {})
      })
    )
  )
}

app.on('second-instance', () => {
  loginLaunchStartup.requestReveal()
})

const gmailCleanupRuntime = createGmailCleanupRuntime(() => settingsStore?.get())

app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => gmailCleanupRuntime.apply(contents))
  contents.on('context-menu', (_menuEvent, params) => {
    const template = buildContextMenuTemplate(params, uiLocale(), {
      copyLink: (url) => clipboard.writeText(url),
      isAllowedLink: isAllowedExternalUrl
    })
    if (template.length) Menu.buildFromTemplate(template).popup()
  })
})

const nativeMailNotifications = createNativeMailNotifications(showAccount)
const showMailNotification = nativeMailNotifications.show

function showAccount(accountId: string): void {
  const store = accountStore
  if (!store || appQuitting || accountRemoval?.isBusy()) return
  if (!store.getState().accounts.some((account) => account.id === accountId)) return
  const state = store.activate(accountId)
  const window = mainWindow
  // A new window picks up the active account itself when its renderer loads the account state.
  if (!window || window.isDestroyed()) {
    createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.send(ACCOUNT_STATE_EVENT, state)
  if (state.activeAccountId) activateAccountView(state.activeAccountId)
}

function publishAccountState(owner: BrowserWindow, state: AccountState): void {
  if (mainWindow === owner && !owner.isDestroyed()) {
    owner.webContents.send(ACCOUNT_STATE_EVENT, state)
  }
}

function activateAccountView(accountId: string): void {
  try {
    accountViewManager?.activate(accountId)
  } catch {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
    }
  }
}

const mainWindowRuntime = createMainWindowRuntime({
  rendererUrl,
  preloadFile: join(__dirname, '../preload/index.js'),
  window: () => mainWindow,
  setWindow: (window, current) => {
    if (window) mainWindow = window
    else if (mainWindow === current) mainWindow = null
  },
  views: () => accountViewManager,
  setViews: (views, current) => {
    if (views) accountViewManager = views
    else if (accountViewManager === current) accountViewManager = null
  },
  accessController: () => accountAccessController,
  setAccessController: (controller, current) => {
    if (controller) accountAccessController = controller
    else if (accountAccessController === current) accountAccessController = null
  },
  googleRuntime: () => googleConnectionRuntime,
  requireAccountStore,
  requireGoogleRuntime: requireGoogleConnectionRuntime,
  requireGoogleManager: requireGoogleConnectionManager,
  settings: () => settingsStore,
  windowState: () => windowStateStore,
  isQuitting: () => appQuitting,
  recovery: notificationRecoveryRuntime,
  notificationController: () => notificationConnectionController,
  loadGoogleConfig: () =>
    loadRuntimeGoogleOAuthConfig({
      environment: process.env,
      isPackaged: app.isPackaged,
      localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
      bundled: __HANTONG_BUNDLED_ENV__
    }),
  publishAccountState,
  openExternal: (url) => shell.openExternal(url),
  openValidatedExternal: openExternal,
  reportIdentityDiagnostic: (reason) => reportOAuthDiagnostic('identity', reason)
})

void app
  .whenReady()
  .then(() => {
    if (app.isPackaged && process.platform === 'darwin') {
      try {
        wasOpenedAtLogin = app.getLoginItemSettings().wasOpenedAtLogin
      } catch {
        wasOpenedAtLogin = false
      }
    }
    const diagnostics = createMainDiagnostics({
      now: () => Date.now(),
      sink: createRotatingDiagnosticsSink({
        path: join(app.getPath('userData'), 'diagnostics.jsonl'),
        maxBytes: 128 * 1024,
        maxFiles: 3
      })
    })
    accountStore = createAccountStore(app.getPath('userData'))
    settingsStore = createSettingsStore(app.getPath('userData'))
    const pauseController = createNotificationPauseController({
      store: createNotificationPauseStore(app.getPath('userData')),
      now: () => Date.now(),
      onChange: () => installAppMenu()
    })
    notificationPauseController = pauseController
    windowStateStore = createWindowStateStore(app.getPath('userData'))
    nativeTheme.themeSource = settingsStore.get().theme
    installAppMenu()
    const mailRuntime = createMainMailRuntime({
      diagnostics,
      requireAccountStore,
      window: () => mainWindow,
      views: () => accountViewManager,
      accessController: () => accountAccessController,
      accountRemoval: () => accountRemoval,
      tray: () => tray,
      isQuitting: () => appQuitting,
      recovery: notificationRecoveryRuntime,
      locale: uiLocale,
      notify: showMailNotification,
      notificationPause: () => pauseController.snapshot(),
      refreshNotificationPause: () => pauseController.refresh(),
      reportOAuthDiagnostic,
      bundledEnvironment: __HANTONG_BUNDLED_ENV__
    })
    googleConnectionManager = mailRuntime.connectionManager
    relayRuntime = mailRuntime.relayRuntime
    gmailRelaySync = mailRuntime.gmailRelaySync
    googleConnectionRuntime = mailRuntime.googleConnectionRuntime
    notificationConnectionController = mailRuntime.notificationConnectionController
    const mailAlerts = mailRuntime.mailAlerts
    fallbackSync = mailRuntime.fallbackSync
    updateRuntime = createAppUpdateRuntime({
      enabled: app.isPackaged && process.platform === 'darwin',
      version: app.getVersion(),
      locale: uiLocale,
      parentWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined),
      onStateChanged: (state) => {
        // Sync is already torn down once install cleanup ran; a staged update applies on any quit.
        if (quitCleanupComplete && state.kind !== 'installing') app.quit()
        else installAppMenu()
      },
      // Native staging already succeeded here, so cleanup is best-effort exactly as on before-quit.
      prepareToInstall: async () => {
        await prepareApplicationShutdown().catch(() =>
          console.error('Unable to cancel pending Google connections')
        )
        appQuitting = true
        quitCleanupComplete = true
      }
    })
    installAppMenu()
    accountRemoval = createAccountRemovalController(
      requireAccountStore(),
      clearAccountSession,
      async (id) => {
        const access = accountAccessController
        if (!access) throw new Error('Account access is unavailable')
        const result = await access.disconnect(id)
        if (result.connectionStatus !== 'disconnected')
          throw new Error('Unable to disconnect Google API')
      }
    )
    registerMainIpc({
      rendererUrl,
      window: () => mainWindow,
      views: () => accountViewManager,
      access: () => accountAccessController,
      notifications: () => notificationConnectionController,
      settings: () => settingsStore,
      isQuitting: () => appQuitting,
      requireAccountStore,
      requireAccountRemoval,
      requireGoogleRuntime: requireGoogleConnectionRuntime,
      recovery: notificationRecoveryRuntime,
      gmailCleanup: gmailCleanupRuntime,
      unreadCounts: () => mailAlerts,
      locale: uiLocale,
      activateView: activateAccountView,
      publishAccountState,
      installAppMenu,
      createWindow,
      loginLaunch
    })
    loginLaunchStartup.start(wasOpenedAtLogin)
    app.on('before-quit', (event) => {
      if (quitCleanupComplete) return
      event.preventDefault()
      if (quitCleanupPending) return
      quitCleanupPending = true
      updateRuntime?.dispose()
      void prepareApplicationShutdown()
        .then(() => {
          appQuitting = true
          quitCleanupComplete = true
          updateRuntime?.dispose()
          app.quit()
        })
        .catch(() => {
          console.error('Unable to cancel pending Google connections')
          appQuitting = true
          quitCleanupComplete = true
          updateRuntime?.dispose()
          app.quit()
        })
    })
  })
  .catch(() => {
    console.error('Unable to start Hantong')
    app.quit()
  })
