import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  dialog,
  nativeImage,
  Tray,
  nativeTheme,
  shell,
  safeStorage
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAccountStore } from '~/main/accounts/account-store'
import { createAccountViewManager } from '~/main/accounts/account-view-manager'
import { createAccountAccessController } from '~/main/accounts/account-access-controller'
import { createMainWindowRuntime } from '~/main/app/main-window-runtime'
import { registerMainIpc } from '~/main/ipc/main-ipc'
import { createAccountRemovalController } from '~/main/accounts/account-removal'
import { clearAccountSession } from '~/main/accounts/account-session-cleanup'
import { createGoogleConnectionManager } from '~/main/google/google-connection-manager'
import { createGoogleConnectionRuntime } from '~/main/google/google-connection-runtime'
import { loadRuntimeGoogleOAuthConfig } from '~/main/google/google-oauth-runtime-config'
import { createRelayRuntime } from '~/main/relay/relay-runtime'
import { createSettingsStore } from '~/main/app/settings-store'
import {
  buildAppMenuTemplate,
  buildContextMenuTemplate,
  buildTrayMenuTemplate
} from '~/main/app/app-menu'
import trayIconPath from '../../resources/icon.png?asset'
import { createWindowStateStore } from '~/main/app/window-state'
import { createGmailCleanupRuntime } from '~/main/gmail/gmail-cleanup-runtime'
import { createAppUpdateRuntime } from '~/main/app/app-update-runtime'
import type { AccountState } from '~/shared/accounts'
import type { AccountRemovalOutcome } from '~/shared/ipc'
import { createGmailRelaySync } from '~/main/gmail/gmail-relay-sync'
import { createNotificationConnectionController } from '~/main/notifications/notification-connection-controller'
import {
  createMainDiagnostics,
  createRotatingDiagnosticsSink
} from '~/main/diagnostics/main-diagnostics'
import { createNativeMailNotifications } from '~/main/notifications/native-mail-notifications'
import { createNotificationRecoveryRuntime } from '~/main/notifications/notification-recovery-runtime'
import { createMainMailRuntime } from '~/main/mail/main-mail-runtime'
import { is } from '@electron-toolkit/utils'
import {
  ACCOUNT_STATE_EVENT,
  SETTINGS_OPEN_EVENT,
  ACCOUNT_VIEW_STATUS_EVENT,
  AI_MAIL_CODEX_STATUS_EVENT
} from '~/shared/ipc'
import { isAllowedExternalUrl } from '~/main/security/security-policy'
import { createNotificationPauseStore } from '~/main/notifications/notification-pause-store'
import { createLoginLaunchPromptStore } from '~/main/app/login-launch-prompt-store'
import { createLoginLaunchController } from '~/main/app/login-launch'
import { createLoginLaunchStartupController } from '~/main/app/login-launch-startup'
import { createAiMailCodexService } from '~/main/ai/codex/ai-mail-codex-service'
import { createOllamaService } from '~/main/ai/ollama/ollama-service'
import { createAiMailOllamaGenerationService } from '~/main/ai/ollama/ai-mail-ollama-service'
import { createMastraOllamaProvider } from '~/main/ai/ollama/mastra-ollama-provider'
import { createOllamaCredentialStore } from '~/main/ai/ollama/ollama-credential-store'
import type { createGmailComposeTargetService } from '~/main/gmail/gmail-compose-target'
import type { createGmailReadTargetService } from '~/main/gmail/gmail-read-target'
import {
  createNotificationPauseController,
  createNotificationPauseMenuActions
} from '~/main/notifications/notification-pause'
import { configureIsolatedGmailComposeProbeProfile } from '~/main/gmail/gmail-compose-probe'

configureIsolatedGmailComposeProbeProfile({
  app,
  argv: process.argv,
  isPackaged: app.isPackaged,
  onProcessExit: (listener) => process.once('exit', listener)
})

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
let composeTargetService: ReturnType<typeof createGmailComposeTargetService> | null = null
let readTargetService: ReturnType<typeof createGmailReadTargetService> | null = null
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
let mainDiagnostics: ReturnType<typeof createMainDiagnostics> | null = null
let loginLaunchPromptStore: ReturnType<typeof createLoginLaunchPromptStore> | null = null
let gmailExternalPromptOpen = false

async function confirmGmailExternalNavigation(url: string): Promise<void> {
  const owner = mainWindow
  if (gmailExternalPromptOpen || !owner || owner.isDestroyed() || appQuitting) return

  gmailExternalPromptOpen = true
  try {
    const korean = uiLocale() === 'ko'
    const { response } = await dialog.showMessageBox(owner, {
      type: 'question',
      message: korean ? '외부 브라우저에서 링크를 열까요?' : 'Open this link in your browser?',
      detail: new URL(url).origin,
      buttons: korean ? ['취소', '열기'] : ['Cancel', 'Open'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (response === 1 && mainWindow === owner && !owner.isDestroyed() && !appQuitting) {
      await shell.openExternal(url)
    }
  } finally {
    gmailExternalPromptOpen = false
  }
}

const notificationRecoveryRuntime = createNotificationRecoveryRuntime({
  window: () => mainWindow,
  views: () => accountViewManager,
  accessController: () => accountAccessController,
  notificationController: () => notificationConnectionController,
  accountRemoval: () => accountRemoval,
  accountStore: () => accountStore,
  isQuitting: () => appQuitting,
  locale: uiLocale,
  showAccount
})
const aiMailCodex = createAiMailCodexService({
  resourcesDirectory: process.resourcesPath,
  appDataDirectory: app.getPath('userData'),
  openExternal: async (url) => {
    await shell.openExternal(url)
  },
  onStatus: (status) => {
    const window = mainWindow
    if (window && !window.isDestroyed()) window.webContents.send(AI_MAIL_CODEX_STATUS_EVENT, status)
  }
})
const ollama = createOllamaService()
const ollamaCredentials = createOllamaCredentialStore({
  directory: app.getPath('userData'),
  safeStorage
})
const aiModel = createMastraOllamaProvider({ local: ollama })
const aiMailOllama = createAiMailOllamaGenerationService({
  provider: aiModel,
  settings: () => settingsStore?.get() ?? null,
  remoteCredential: (endpoint) => ollamaCredentials.get(endpoint)
})
const loginLaunch = createLoginLaunchController({
  supported: process.platform === 'darwin' && app.isPackaged,
  getLoginItemSettings: () => app.getLoginItemSettings(),
  setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
  ownerAlive: () => mainWindow !== null && !mainWindow.isDestroyed(),
  confirmEnable: async () => {
    const owner = mainWindow
    if (!owner || owner.isDestroyed() || appQuitting) return undefined
    const korean = uiLocale() === 'ko'
    const result = await dialog.showMessageBox(owner, {
      type: 'question',
      title: korean ? '로그인 시 실행' : 'Launch at Login',
      message: korean
        ? '한통을 로그인할 때 자동으로 실행할까요?'
        : 'Launch Hantong automatically when you log in?',
      detail: korean
        ? 'macOS 로그인 항목에 한통을 등록합니다.'
        : 'Hantong will be added to your macOS Login Items.',
      buttons: korean ? ['취소', '허용'] : ['Cancel', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (mainWindow !== owner || owner.isDestroyed() || appQuitting) return undefined
    if (result.response !== 0 && result.response !== 1) return undefined
    return result.response === 1
  },
  promptSeen: () => loginLaunchPromptStore?.isSeen() ?? false,
  markPromptSeen: () => {
    if (!loginLaunchPromptStore) throw new Error('Login launch prompt storage is unavailable')
    loginLaunchPromptStore.markSeen()
  },
  onDiagnostic: (event) => mainDiagnostics?.record(event)
})

function prepareApplicationShutdown(): Promise<void> {
  if (cleanupPromise) return cleanupPromise
  if (fallbackSync) clearInterval(fallbackSync)
  gmailRelaySync?.dispose()
  notificationConnectionController?.dispose()
  notificationPauseController?.dispose()
  notificationRecoveryRuntime.resolveAll()
  const cleanup = Promise.all([
    aiMailCodex.dispose(),
    Promise.resolve(aiMailOllama.dispose()),
    Promise.resolve(ollama.dispose()),
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

function removeAccountAfterGmailLogout(
  accountId: string,
  views: ReturnType<typeof createAccountViewManager>,
  owner: BrowserWindow
): Promise<AccountRemovalOutcome | 'skipped'> {
  return (async (): Promise<AccountRemovalOutcome | 'skipped'> => {
    const store = accountStore
    const removal = accountRemoval
    if (
      appQuitting ||
      !store ||
      !removal ||
      !store.getState().accounts.some((account) => account.id === accountId)
    )
      return 'skipped'
    const ownerIsAlive = (): boolean => !appQuitting
    const result = await removal.removeWhenIdle(accountId, {
      ownerIsAlive,
      confirm: async () => true,
      disposeView: (id) => views.disposeAccount(id),
      activate: (id) => {
        if (!owner.isDestroyed()) views.activate(id)
      }
    })
    if (result.outcome === 'removed') {
      views.forgetLogoutLock(accountId)
      accountAccessController?.forget(accountId)
      notificationRecoveryRuntime.clearPending(accountId)
      notificationConnectionController?.disconnect(accountId)
      publishAccountState(owner, result.state)
    } else if (result.outcome === 'failed' && !owner.isDestroyed()) {
      owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
    }
    return result.outcome
  })().catch(() => {
    if (!owner.isDestroyed())
      owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
    return 'failed'
  })
}

function activateAccountView(accountId: string): void {
  composeTargetService?.onAccountSwitch()
  readTargetService?.onAccountSwitch()
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
    if (current) aiMailOllama.cancelOwner(current)
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
  setComposeTargetService: (service) => {
    composeTargetService = service
  },
  setReadTargetService: (service) => {
    readTargetService = service
  },
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
  openExternal: confirmGmailExternalNavigation,
  openValidatedExternal: openExternal,
  reportIdentityDiagnostic: (reason, accountId) => {
    mainDiagnostics?.record({
      type: 'oauth.progress',
      accountId,
      stage: 'identity_check',
      outcome: 'failure',
      code: reason
    })
  },
  reportViewLoadDiagnostic: (accountId, diagnostic) => {
    if (!mainDiagnostics) return
    switch (diagnostic.type) {
      case 'load_failure':
        mainDiagnostics.record({
          type: 'gmail.load.failure',
          accountId,
          ...(diagnostic.errorCode !== undefined ? { errorCode: diagnostic.errorCode } : {})
        })
        break
      case 'load_timeout':
        mainDiagnostics.record({ type: 'gmail.load.timeout', accountId })
        break
      case 'process_gone':
        mainDiagnostics.record({
          type: 'gmail.process.gone',
          accountId,
          reason: diagnostic.reason
        })
        break
    }
  },
  reportNavigationDiagnostic: (accountId, diagnostic) => {
    mainDiagnostics?.record({
      type: 'gmail.navigation.blocked',
      accountId,
      source: diagnostic.source,
      context: diagnostic.context,
      hostname: diagnostic.hostname,
      route: diagnostic.route,
      reason: diagnostic.reason
    })
  },
  removeExplicitLogout: removeAccountAfterGmailLogout
})

void app
  .whenReady()
  .then(() => {
    const diagnostics = createMainDiagnostics({
      now: () => Date.now(),
      sink: createRotatingDiagnosticsSink({
        path: join(app.getPath('userData'), 'diagnostics.jsonl'),
        maxBytes: 128 * 1024,
        maxFiles: 3
      })
    })
    mainDiagnostics = diagnostics
    if (app.isPackaged && process.platform === 'darwin') {
      try {
        const loginSettings = app.getLoginItemSettings()
        wasOpenedAtLogin = loginSettings.wasOpenedAtLogin
        diagnostics.record({
          type: 'login.launch',
          operation: 'startup_read',
          openAtLogin: loginSettings.openAtLogin,
          status:
            loginSettings.status === 'enabled' ||
            loginSettings.status === 'not-registered' ||
            loginSettings.status === 'requires-approval' ||
            loginSettings.status === 'not-found'
              ? loginSettings.status
              : loginSettings.status === undefined
                ? 'missing'
                : 'unknown',
          outcome: 'success'
        })
      } catch {
        wasOpenedAtLogin = false
        diagnostics.record({
          type: 'login.launch',
          operation: 'startup_read',
          status: 'missing',
          outcome: 'failure'
        })
      }
    }
    accountStore = createAccountStore(app.getPath('userData'))
    settingsStore = createSettingsStore(app.getPath('userData'))
    loginLaunchPromptStore = createLoginLaunchPromptStore(app.getPath('userData'))
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
      bundledEnvironment: __HANTONG_BUNDLED_ENV__,
      revealForAuthorization: () => {
        loginLaunchStartup.requestReveal()
        app.focus({ steal: true })
      }
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
      writeClipboardText: (text) => clipboard.writeText(text),
      aiModel,
      ollamaCredentials,
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
      loginLaunch,
      aiMailCodex,
      aiMailOllama,
      ollama,
      composeTarget: () => composeTargetService,
      recordComposeDiagnostic: (accountId, event) =>
        mainDiagnostics?.record({ type: 'ai_mail.compose', accountId, ...event }),
      readTarget: () => readTargetService
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
