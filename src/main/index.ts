import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeImage,
  Tray,
  dialog,
  ipcMain,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  screen,
  shell,
  webContents
} from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAccountStore } from './account-store'
import { createAccountViewManager } from './account-view-manager'
import { createAccountAccessController } from './account-access-controller'
import { createAccountRemovalController } from './account-removal'
import { clearAccountSession } from './account-session-cleanup'
import { createGoogleCredentialStore } from './google-credential-store'
import { createGoogleConnectionManager } from './google-connection-manager'
import { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { GoogleConnectionFailureCode } from './google-connection'
import type { GoogleWebIdentityFailureReason } from './google-web-identity'
import { loadRuntimeGoogleOAuthConfig } from './google-oauth-runtime-config'
import { loadRuntimeRelayConfig } from './relay-config'
import { createRelayClient } from './relay-client'
import { createRelayRuntime } from './relay-runtime'
import { createRelayCredentialStore } from './relay-credential-store'
import { createSettingsStore } from './settings-store'
import { buildAppMenuTemplate, buildContextMenuTemplate, buildTrayMenuTemplate } from './app-menu'
import trayIconPath from '../../resources/icon.png?asset'
import { createWindowStateStore, fitWindowBounds } from './window-state'
import { buildGmailCleanupCss } from './gmail-cleanup'
import { isAccountColor, type AccountState } from '../shared/accounts'
import type { AppSettingsPatch } from '../shared/settings'
import { createGmailSyncStore } from './gmail-sync-store'
import { createGmailHistorySync } from './gmail-history-sync'
import { createGmailWatchManager } from './gmail-watch-manager'
import { createGmailRelaySync } from './gmail-relay-sync'
import { createGmailMailAlerts, type GmailMailAlert } from './gmail-mail-alerts'
import { buildMailNotificationOptions } from './mail-notification'
import { updateTrayUnreadCount } from './tray-unread-count'
import {
  fetchGmailHistoryId,
  fetchGmailHistoryPage,
  fetchGmailMessageSummary,
  fetchGmailUnreadCount,
  registerGmailWatch
} from './gmail-metadata'
import { startGoogleAuthorization } from './google-authorization'
import type { AuthorizationErrorCode } from './google-authorization'
import {
  exchangeGoogleAuthorizationCode,
  fetchGoogleProfileEmail,
  refreshGoogleAccessToken
} from './google-token-exchange'
import { is, optimizer } from '@electron-toolkit/utils'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_MOVE_CHANNEL,
  ACCOUNT_DISPLAY_NAME_CHANNEL,
  ACCOUNT_COLOR_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_REMOVE_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STATE_EVENT,
  ACCOUNT_STATUS_STRIP_CHANNEL,
  UNREAD_COUNTS_CHANNEL,
  UNREAD_COUNTS_EVENT,
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  SETTINGS_EVENT,
  SETTINGS_PANEL_CHANNEL,
  SETTINGS_OPEN_EVENT,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  GOOGLE_CONNECTION_CANCEL_CHANNEL,
  GOOGLE_CONNECTION_CONNECT_CHANNEL,
  GOOGLE_CONNECTION_DISCONNECT_CHANNEL,
  GOOGLE_CONNECTION_STATUS_CHANNEL,
  ACCOUNT_ACCESS_STATE_CHANNEL,
  ACCOUNT_ACCESS_STATE_EVENT,
  type AppInfo
} from '../shared/ipc'
import {
  isAllowedAccountRequest,
  isAllowedAppInfoRequest,
  isAllowedExternalUrl,
  isAllowedGoogleConnectionRequest,
  isAllowedSettingsRequest,
  isTrustedRendererUrl
} from './security-policy'

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
let windowStateStore: ReturnType<typeof createWindowStateStore> | null = null
let tray: Tray | null = null
let accountViewManager: ReturnType<typeof createAccountViewManager> | null = null
let accountRemoval: ReturnType<typeof createAccountRemovalController> | null = null
let googleConnectionRuntime: ReturnType<typeof createGoogleConnectionRuntime> | null = null
let googleConnectionManager: ReturnType<typeof createGoogleConnectionManager> | null = null
let relayRuntime: ReturnType<typeof createRelayRuntime> | null = null
let gmailRelaySync: ReturnType<typeof createGmailRelaySync> | null = null
let accountAccessController: ReturnType<typeof createAccountAccessController> | null = null
let appQuitting = false
let quitCleanupPending = false
let quitCleanupComplete = false

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
  const saved = windowStateStore?.read() ?? null
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
      preload: join(__dirname, '../preload/index.js'),
      partition: 'hantong-ui',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false
    }
  })
  mainWindow = window
  if (bounds && saved?.maximized) window.maximize()
  window.on('close', (event) => {
    windowStateStore?.write({ bounds: window.getNormalBounds(), maximized: window.isMaximized() })
    // Hiding keeps Main, the relay stream and notifications alive; quitting goes through before-quit.
    if (!appQuitting && (settingsStore?.get().closeAction ?? 'hide') === 'hide') {
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
  })
  let windowAccessController: ReturnType<typeof createAccountAccessController> | null = null
  const windowViewManager = createAccountViewManager(
    window,
    requireAccountStore(),
    (status) => {
      if (!window.isDestroyed()) window.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, status)
      if (
        status.status === 'ready' ||
        status.status === 'blocked' ||
        status.status === 'error' ||
        status.status === 'loading'
      ) {
        windowAccessController?.onViewReady(status.accountId)
      }
    },
    (url) => shell.openExternal(url),
    30_000,
    (reason) => reportOAuthDiagnostic('identity', reason)
  )
  accountViewManager = windowViewManager
  const savedSettings = settingsStore?.get()
  windowViewManager.setLayout(
    savedSettings?.accountSelectorPosition ?? 'top',
    savedSettings?.sidebarCollapsed ?? false
  )
  windowAccessController = createAccountAccessController({
    views: windowViewManager,
    runtime: requireGoogleConnectionRuntime(),
    connections: requireGoogleConnectionManager(),
    loadConfig: () =>
      loadRuntimeGoogleOAuthConfig({
        environment: process.env,
        isPackaged: app.isPackaged,
        localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
        bundled: __HANTONG_BUNDLED_ENV__
      }),
    fetchProfile: async (accessToken, signal) => {
      const email = await fetchGoogleProfileEmail(accessToken, { fetch, signal })
      if (!email) throw new Error('Google profile is unavailable')
      return email
    },
    accountExists: (id) =>
      requireAccountStore()
        .getState()
        .accounts.some((account) => account.id === id),
    publish: (state) => {
      if (!window.isDestroyed()) window.webContents.send(ACCOUNT_ACCESS_STATE_EVENT, state)
    },
    onWebIdentity: (accountId, emailAddress) => {
      try {
        const store = requireAccountStore()
        if (
          store.getState().accounts.find((account) => account.id === accountId)?.email ===
          emailAddress
        ) {
          return
        }
        const state = store.recordWebIdentityEmail(accountId, emailAddress)
        publishAccountState(window, state)
      } catch {
        // Identity persistence must not block mailbox access; never log the account email.
        console.error('Unable to save Gmail web identity')
      }
    }
  })
  accountAccessController = windowAccessController

  const contents = window.webContents
  contents.session.setPermissionCheckHandler(() => false)
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isTrustedRendererUrl(event.url, rendererUrl)) {
      event.preventDefault()
    }
  })
  contents.on('will-redirect', (event) => {
    if (!isTrustedRendererUrl(event.url, rendererUrl)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  window.once('ready-to-show', () => window.show())
  window.once('closed', () => {
    if (!appQuitting && settingsStore?.get().closeAction === 'quit') app.quit()
    void googleConnectionRuntime?.cancelAll().catch(() => {
      console.error('Unable to cancel pending Google connections')
    })
    void windowViewManager.dispose().catch(() => {
      console.error('Unable to close Gmail views')
    })
    windowAccessController?.dispose()
    if (accountAccessController === windowAccessController) accountAccessController = null
    if (accountViewManager === windowViewManager) accountViewManager = null
    if (mainWindow === window) mainWindow = null
  })
  optimizer.watchWindowShortcuts(window)

  void contents.loadURL(rendererUrl).catch(() => {
    console.error('Unable to load the Hantong window')
    window.destroy()
    app.quit()
  })
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

// Rebuilt whenever the language changes, so every Hantong-owned label follows the setting.
function installAppMenu(): void {
  const locale = uiLocale()
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(locale, { openSettings })))
  if (!tray) {
    // A small copy of the app icon; a monochrome template icon can replace it later.
    tray = new Tray(nativeImage.createFromPath(trayIconPath).resize({ width: 18, height: 18 }))
    tray.setToolTip('Hantong')
    tray.on('click', showMainWindow)
  }
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildTrayMenuTemplate(locale, { open: showMainWindow, quit: () => app.quit() })
    )
  )
}

app.on('second-instance', () => {
  const window = mainWindow
  if (!window || window.isDestroyed()) {
    if (app.isReady() && accountStore) createWindow()
    return
  }
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

// Each Gmail document gets at most one cleanup stylesheet; calls are chained so toggles cannot
// interleave and leave a stale stylesheet behind.
const gmailCleanupKeys = new WeakMap<Electron.WebContents, string>()
const gmailCleanupQueue = new WeakMap<Electron.WebContents, Promise<void>>()

function isGmailDocument(contents: Electron.WebContents): boolean {
  try {
    return new URL(contents.getURL()).origin === 'https://mail.google.com'
  } catch {
    return false
  }
}

function applyGmailCleanup(contents: Electron.WebContents): void {
  const run = async (): Promise<void> => {
    if (contents.isDestroyed()) return
    const previous = gmailCleanupKeys.get(contents)
    gmailCleanupKeys.delete(contents)
    // A key from an earlier document is already gone; removing it is a harmless no-op.
    if (previous) await contents.removeInsertedCSS(previous).catch(() => undefined)
    const css = settingsStore ? buildGmailCleanupCss(settingsStore.get()) : ''
    if (!css || contents.isDestroyed() || !isGmailDocument(contents)) return
    gmailCleanupKeys.set(contents, await contents.insertCSS(css))
  }
  const next = (gmailCleanupQueue.get(contents) ?? Promise.resolve()).then(run).catch(() => {
    // CSS that fails to apply leaves Gmail's original interface in place.
  })
  gmailCleanupQueue.set(contents, next)
}

app.on('web-contents-created', (_event, contents) => {
  contents.on('dom-ready', () => applyGmailCleanup(contents))
  contents.on('context-menu', (_menuEvent, params) => {
    const template = buildContextMenuTemplate(params, uiLocale(), {
      copyLink: (url) => clipboard.writeText(url),
      isAllowedLink: isAllowedExternalUrl
    })
    if (template.length) Menu.buildFromTemplate(template).popup()
  })
})

// Electron drops click handlers of notifications that get garbage-collected, so keep them alive.
const shownNotifications = new Set<Notification>()

function showMailNotification(alert: GmailMailAlert): void {
  if (!Notification.isSupported()) return
  const notification = new Notification(buildMailNotificationOptions(alert))
  const forget = (): void => {
    shownNotifications.delete(notification)
  }
  notification.on('click', () => {
    forget()
    showAccount(alert.accountId)
  })
  notification.on('close', forget)
  shownNotifications.add(notification)
  notification.show()
}

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

void app
  .whenReady()
  .then(() => {
    accountStore = createAccountStore(app.getPath('userData'))
    settingsStore = createSettingsStore(app.getPath('userData'))
    windowStateStore = createWindowStateStore(app.getPath('userData'))
    nativeTheme.themeSource = settingsStore.get().theme
    installAppMenu()
    const credentialStore = createGoogleCredentialStore({
      directory: join(app.getPath('userData'), 'google-credentials'),
      platform: process.platform,
      safeStorage
    })
    const connectionManager = createGoogleConnectionManager({
      credentialStore,
      now: () => Date.now(),
      refreshTokens: (config, refreshToken, signal) =>
        refreshGoogleAccessToken(config, refreshToken, {
          fetch,
          signal,
          now: () => Date.now()
        })
    })
    googleConnectionManager = connectionManager
    let relayClient: ReturnType<typeof createRelayClient> | undefined
    const relayConfig = (): ReturnType<typeof loadRuntimeRelayConfig> =>
      loadRuntimeRelayConfig({
        environment: process.env,
        isPackaged: app.isPackaged,
        localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
        bundled: __HANTONG_BUNDLED_ENV__
      })
    const accountExists = (id: string): boolean =>
      requireAccountStore()
        .getState()
        .accounts.some((account) => account.id === id)
    const resolveRelayClient = (): ReturnType<typeof createRelayClient> | undefined => {
      if (relayClient) return relayClient
      const config = relayConfig()
      if (!config) return undefined
      relayClient = createRelayClient({ baseUrl: config.baseUrl, fetch, now: () => Date.now() })
      return relayClient
    }
    const gmailAccessToken = (accountId: string): Promise<string> =>
      connectionManager.getAccessToken(
        accountId,
        loadRuntimeGoogleOAuthConfig({
          environment: process.env,
          isPackaged: app.isPackaged,
          localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
          bundled: __HANTONG_BUNDLED_ENV__
        })
      )
    let gmailTopic: string | undefined
    try {
      gmailTopic = relayConfig()?.gmailTopic
    } catch {
      // Invalid relay settings already disable the relay session; a watch is useless without it.
      gmailTopic = undefined
    }
    const historySync = createGmailHistorySync({
      store: createGmailSyncStore(app.getPath('userData')),
      accountExists,
      readHistoryId: async (accountId, signal) =>
        fetchGmailHistoryId(await gmailAccessToken(accountId), { fetch, signal }),
      readHistoryPage: async (accountId, startHistoryId, pageToken, signal) =>
        fetchGmailHistoryPage(await gmailAccessToken(accountId), startHistoryId, pageToken, {
          fetch,
          signal
        })
    })
    const korean = (): boolean => uiLocale() === 'ko'
    const mailAlerts = createGmailMailAlerts({
      accountExists,
      korean,
      readUnreadCount: async (accountId) =>
        fetchGmailUnreadCount(await gmailAccessToken(accountId), 'INBOX', {
          fetch,
          signal: AbortSignal.timeout(30_000)
        }),
      readSummary: async (accountId, messageId) =>
        fetchGmailMessageSummary(await gmailAccessToken(accountId), messageId, {
          fetch,
          signal: AbortSignal.timeout(30_000)
        }),
      notify: showMailNotification,
      setBadge: (total) => {
        app.setBadgeCount(total)
        updateTrayUnreadCount(total, process.platform, (title) => tray?.setTitle(title))
        const window = mainWindow
        if (window && !window.isDestroyed()) {
          window.webContents.send(
            UNREAD_COUNTS_EVENT,
            Object.fromEntries(mailAlerts.unreadCounts())
          )
        }
      }
    })
    const topic = gmailTopic
    gmailRelaySync = createGmailRelaySync({
      sync: (accountId) => historySync.sync(accountId),
      resetSync: (accountId) => historySync.reset(accountId),
      watch: topic
        ? createGmailWatchManager({
            accountExists,
            registerWatch: async (accountId, signal) =>
              registerGmailWatch(await gmailAccessToken(accountId), topic, {
                fetch,
                signal,
                now: () => Date.now()
              })
          })
        : undefined,
      now: () => Date.now(),
      onChanges: (accountId, result) => {
        void mailAlerts.onChanges(accountId, result).catch(() => undefined)
      }
    })
    const allAccountIds = (): string[] =>
      requireAccountStore()
        .getState()
        .accounts.map((account) => account.id)
    powerMonitor.on('suspend', () => gmailRelaySync?.suspend())
    powerMonitor.on('resume', () => gmailRelaySync?.resume(allAccountIds()))
    // ponytail: fixed 15-minute fallback poll; derive from relay health if quota or latency matters.
    const fallbackSync = setInterval(() => gmailRelaySync?.syncAll(allAccountIds()), 15 * 60_000)
    // Catch up on mail that arrived while the app was closed; never-connected accounts just fail.
    gmailRelaySync.syncAll(allAccountIds())
    relayRuntime = createRelayRuntime({
      client: {
        createSession: (...args) => {
          const client = relayClient ?? resolveRelayClient()
          if (!client) return Promise.reject(new Error('Relay is disabled'))
          return client.createSession(...args)
        },
        refreshSession: (...args) => {
          const client = relayClient ?? resolveRelayClient()
          if (!client) return Promise.reject(new Error('Relay is disabled'))
          return client.refreshSession(...args)
        },
        consumeEvents: (...args) =>
          relayClient?.consumeEvents(...args) ?? Promise.reject(new Error('Relay is disabled')),
        deleteSession: (token) => relayClient?.deleteSession(token) ?? Promise.resolve()
      },
      accountExists,
      now: () => Date.now(),
      credentials: createRelayCredentialStore({
        directory: join(app.getPath('userData'), 'relay-credentials'),
        platform: process.platform,
        safeStorage
      }),
      onSignal: (accountId, event) => gmailRelaySync?.onSignal(accountId, event)
    })
    let relayEnabled = false
    try {
      relayEnabled = relayConfig() !== undefined
    } catch {
      // Invalid relay settings leave the relay off; Gmail still syncs through the fallback poll.
    }
    // Reattach saved relay sessions without a browser round-trip; unknown accounts are skipped.
    if (relayEnabled) {
      for (const accountId of allAccountIds()) void relayRuntime.resume(accountId)
    }
    googleConnectionRuntime = createGoogleConnectionRuntime({
      accountExists,
      readWebIdentity: (id, signal) =>
        accountViewManager?.readWebIdentity(id, signal) ?? Promise.resolve(null),
      loadConfig: () =>
        loadRuntimeGoogleOAuthConfig({
          environment: process.env,
          isPackaged: app.isPackaged,
          localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
          bundled: __HANTONG_BUNDLED_ENV__
        }),
      prepareRelayChallenge: async (signal) => {
        try {
          const client = resolveRelayClient()
          if (!client) return undefined
          return (await client.fetchChallenge(signal)).nonce
        } catch (error) {
          if (
            signal.aborted ||
            (typeof error === 'object' &&
              error !== null &&
              'code' in error &&
              error.code === 'cancelled')
          ) {
            throw Object.assign(new Error('Relay challenge cancelled'), { code: 'cancelled' })
          }
          if (!app.isPackaged) console.error('[Hantong Relay] unavailable')
          return undefined
        }
      },
      startAuthorization: (config, nonce) =>
        startGoogleAuthorization(config, {
          openExternal: (url) => shell.openExternal(url),
          reportFailure: (code) => reportOAuthDiagnostic('authorization', code),
          nonce
        }),
      exchangeCode: (config, authorization, signal) =>
        exchangeGoogleAuthorizationCode(config, authorization, {
          fetch,
          signal,
          now: () => Date.now()
        }),
      fetchProfile: (accessToken, signal) =>
        fetchGoogleProfileEmail(accessToken, { fetch, signal }),
      manager: connectionManager,
      onConnected: (accountId, result) =>
        relayRuntime?.accept(
          accountId,
          result.tokens.idToken && result.relayNonce
            ? { idToken: result.tokens.idToken, nonce: result.relayNonce }
            : {}
        ),
      onDisconnected: (accountId) => {
        relayRuntime?.disconnect(accountId)
        gmailRelaySync?.disconnect(accountId)
        mailAlerts.remove(accountId)
      },
      reportFailure: (stage, code) => reportOAuthDiagnostic(stage, code)
    })
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
    ipcMain.handle(APP_INFO_CHANNEL, (event, ...args: unknown[]): AppInfo => {
      const owner = mainWindow
      const ownerAlive = owner !== null && !owner.isDestroyed()
      if (
        !isAllowedAppInfoRequest({
          ownerAlive,
          senderMatches: ownerAlive && event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl,
          args
        })
      ) {
        throw new Error('Request rejected')
      }
      return {
        name: app.getName(),
        version: app.getVersion(),
        locale: app.getLocale().startsWith('ko') ? 'ko' : 'en'
      }
    })

    function accountRequestAllowed(
      event: Electron.IpcMainInvokeEvent,
      operation:
        'get' | 'add' | 'activate' | 'retry' | 'remove' | 'setDisplayName' | 'setColor' | 'move',
      args: unknown[]
    ): boolean {
      const owner = mainWindow
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const id = typeof args[0] === 'string' ? args[0] : ''
      const state = requireAccountStore().getState()
      return isAllowedAccountRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl,
        operation,
        args,
        accountExists:
          operation === 'activate' ||
          operation === 'remove' ||
          operation === 'setDisplayName' ||
          operation === 'setColor' ||
          operation === 'move'
            ? state.accounts.some((account) => account.id === id)
            : operation === 'retry' && state.activeAccountId !== null
      })
    }

    function googleConnectionRequestAllowed(
      event: Electron.IpcMainInvokeEvent,
      operation: 'get' | 'connect' | 'cancel' | 'disconnect',
      args: unknown[]
    ): boolean {
      const owner = mainWindow
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const id = args.length === 1 && typeof args[0] === 'string' ? args[0] : ''
      const accountExists = requireAccountStore()
        .getState()
        .accounts.some((account) => account.id === id)
      return (
        !appQuitting &&
        !requireAccountRemoval().isBusy() &&
        isAllowedGoogleConnectionRequest({
          ownerAlive,
          senderMatches: ownerAlive && event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl,
          operation,
          args,
          accountExists
        })
      )
    }

    const handleGoogleConnection = (
      channel: string,
      operation: 'get' | 'connect' | 'cancel' | 'disconnect'
    ): void => {
      ipcMain.handle(channel, async (event, ...args: unknown[]) => {
        if (!googleConnectionRequestAllowed(event, operation, args))
          throw new Error('Request rejected')
        const accountId = args[0]
        const owner = mainWindow
        if (typeof accountId !== 'string' || !owner) throw new Error('Request rejected')
        const runtime = requireGoogleConnectionRuntime()
        const accessController = accountAccessController
        let result: Awaited<ReturnType<typeof runtime.getStatus>>
        if (operation === 'get') {
          result = await runtime.getStatus(accountId)
        } else {
          if (!accessController) throw new Error('Request rejected')
          const accessResult =
            operation === 'connect'
              ? await accessController.connect(accountId)
              : operation === 'cancel'
                ? await accessController.cancel(accountId)
                : await accessController.disconnect(accountId)
          result = { accountId, status: accessResult.connectionStatus }
        }
        if (
          mainWindow !== owner ||
          owner.isDestroyed() ||
          event.sender !== owner.webContents ||
          event.senderFrame === null ||
          event.senderFrame !== event.sender.mainFrame ||
          !isTrustedRendererUrl(event.senderFrame.url, rendererUrl) ||
          !requireAccountStore()
            .getState()
            .accounts.some((account) => account.id === accountId)
        )
          throw new Error('Request rejected')
        return result
      })
    }
    handleGoogleConnection(GOOGLE_CONNECTION_STATUS_CHANNEL, 'get')
    handleGoogleConnection(GOOGLE_CONNECTION_CONNECT_CHANNEL, 'connect')
    handleGoogleConnection(GOOGLE_CONNECTION_CANCEL_CHANNEL, 'cancel')
    handleGoogleConnection(GOOGLE_CONNECTION_DISCONNECT_CHANNEL, 'disconnect')

    ipcMain.handle(ACCOUNT_ACCESS_STATE_CHANNEL, (event, ...args: unknown[]) => {
      if (!googleConnectionRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
      const accountId = args[0]
      if (typeof accountId !== 'string' || !accountAccessController)
        throw new Error('Request rejected')
      return accountAccessController.getState(accountId)
    })

    function settingsRequestAllowed(
      event: Electron.IpcMainInvokeEvent,
      operation: 'get' | 'update' | 'panel' | 'status-strip',
      args: unknown[]
    ): boolean {
      const owner = mainWindow
      const ownerAlive = owner !== null && !owner.isDestroyed()
      return isAllowedSettingsRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl,
        operation,
        args
      })
    }
    ipcMain.handle(SETTINGS_GET_CHANNEL, (event, ...args: unknown[]) => {
      if (!settingsRequestAllowed(event, 'get', args) || !settingsStore) {
        throw new Error('Request rejected')
      }
      return settingsStore.get()
    })
    ipcMain.handle(SETTINGS_UPDATE_CHANNEL, (event, ...args: unknown[]) => {
      if (!settingsRequestAllowed(event, 'update', args) || !settingsStore) {
        throw new Error('Request rejected')
      }
      const settings = settingsStore.update(args[0] as AppSettingsPatch) // validated by the policy
      nativeTheme.themeSource = settings.theme
      accountViewManager?.setLayout(settings.accountSelectorPosition, settings.sidebarCollapsed)
      for (const contents of webContents.getAllWebContents()) applyGmailCleanup(contents)
      installAppMenu()
      const owner = mainWindow
      if (owner && !owner.isDestroyed()) owner.webContents.send(SETTINGS_EVENT, settings)
      return settings
    })
    ipcMain.handle(SETTINGS_PANEL_CHANNEL, (event, ...args: unknown[]) => {
      if (!settingsRequestAllowed(event, 'panel', args)) throw new Error('Request rejected')
      return accountViewManager?.setCovered(args[0] === true) ?? null
    })
    ipcMain.handle(ACCOUNT_STATUS_STRIP_CHANNEL, (event, ...args: unknown[]) => {
      if (!settingsRequestAllowed(event, 'status-strip', args)) throw new Error('Request rejected')
      accountViewManager?.setStatusStripVisible(args[0] === true)
    })
    ipcMain.handle(UNREAD_COUNTS_CHANNEL, (event, ...args: unknown[]) => {
      if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
      return Object.fromEntries(mailAlerts.unreadCounts())
    })
    ipcMain.handle(ACCOUNT_STATE_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
      const state = requireAccountStore().getState()
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_ADD_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'add', args)) throw new Error('Request rejected')
      const state = requireAccountStore().add()
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_ACTIVATE_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'activate', args)) throw new Error('Request rejected')
      const id = args[0]
      if (typeof id !== 'string') throw new Error('Request rejected')
      const state = requireAccountStore().activate(id)
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_DISPLAY_NAME_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'setDisplayName', args)) {
        throw new Error('Request rejected')
      }
      const accountId = args[0]
      const displayName = args[1]
      if (
        typeof accountId !== 'string' ||
        (displayName !== null && typeof displayName !== 'string')
      ) {
        throw new Error('Request rejected')
      }
      const owner = mainWindow
      if (!owner) throw new Error('Request rejected')
      const state = requireAccountStore().setDisplayName(accountId, displayName)
      publishAccountState(owner, state)
      return state
    })
    ipcMain.handle(ACCOUNT_COLOR_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'setColor', args)) throw new Error('Request rejected')
      const accountId = args[0]
      const color = args[1]
      if (typeof accountId !== 'string' || typeof color !== 'string')
        throw new Error('Request rejected')
      const owner = mainWindow
      if (!owner) throw new Error('Request rejected')
      if (!isAccountColor(color)) throw new Error('Request rejected')
      const state = requireAccountStore().setColor(accountId, color)
      publishAccountState(owner, state)
      return state
    })
    ipcMain.handle(ACCOUNT_MOVE_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'move', args)) throw new Error('Request rejected')
      const [accountId, toIndex] = args
      if (typeof accountId !== 'string' || typeof toIndex !== 'number') {
        throw new Error('Request rejected')
      }
      const owner = mainWindow
      if (!owner) throw new Error('Request rejected')
      const state = requireAccountStore().move(accountId, toIndex)
      publishAccountState(owner, state)
      return state
    })
    ipcMain.handle(ACCOUNT_RETRY_CHANNEL, (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'retry', args)) throw new Error('Request rejected')
      accountViewManager?.retry()
    })
    ipcMain.handle(ACCOUNT_REMOVE_CHANNEL, async (event, ...args: unknown[]) => {
      requireAccountRemoval().assertIdle()
      if (!accountRequestAllowed(event, 'remove', args)) throw new Error('Request rejected')
      const accountId = args[0]
      const owner = mainWindow
      const viewManager = accountViewManager
      if (typeof accountId !== 'string' || !owner || !viewManager) {
        throw new Error('Request rejected')
      }
      const ownerIsAlive = (): boolean => mainWindow === owner && !owner.isDestroyed()
      const result = await requireAccountRemoval().remove(accountId, {
        ownerIsAlive,
        async confirm(): Promise<boolean> {
          if (!ownerIsAlive()) return false
          const isKorean = uiLocale() === 'ko'
          const response = await dialog.showMessageBox(owner, {
            type: 'warning',
            title: isKorean ? '계정 삭제' : 'Remove account',
            message: isKorean ? '계정을 삭제할까요?' : 'Remove this account?',
            detail: isKorean
              ? '이 기기의 로그인 정보와 세션을 삭제합니다. Google 계정과 메일은 삭제되지 않습니다.'
              : 'This removes its local sign-in and session from this device. Your Google account and email are not deleted.',
            buttons: isKorean ? ['취소', '계정 삭제'] : ['Cancel', 'Remove account'],
            defaultId: 0,
            cancelId: 0,
            noLink: true
          })
          return response.response === 1
        },
        disposeView: (id) => viewManager.disposeAccount(id),
        activate: (id) => {
          if (!ownerIsAlive()) return
          try {
            viewManager.activate(id)
          } catch {
            if (!owner.isDestroyed()) {
              owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId: id, status: 'error' })
            }
          }
        }
      })
      if (result.outcome === 'failed' && ownerIsAlive()) {
        owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
      }
      return result
    })

    createWindow()
    app.on('before-quit', (event) => {
      if (quitCleanupComplete) return
      event.preventDefault()
      if (quitCleanupPending) return
      appQuitting = true
      quitCleanupPending = true
      clearInterval(fallbackSync)
      gmailRelaySync?.dispose()
      const cleanup = Promise.all([
        requireGoogleConnectionRuntime().cancelAll(),
        relayRuntime?.dispose() ?? Promise.resolve()
      ])
      void Promise.race([cleanup, new Promise((resolve) => setTimeout(resolve, 2000))])
        .then(() => {
          quitCleanupComplete = true
          app.quit()
        })
        .catch(() => {
          console.error('Unable to cancel pending Google connections')
          quitCleanupComplete = true
          app.quit()
        })
    })
    app.on('activate', () => {
      if (!mainWindow) createWindow()
      else {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
      }
    })
  })
  .catch(() => {
    console.error('Unable to start Hantong')
    app.quit()
  })
