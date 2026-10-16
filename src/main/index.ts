import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAccountStore } from './account-store'
import { createAccountViewManager } from './account-view-manager'
import { createAccountRemovalController } from './account-removal'
import { clearAccountSession } from './account-session-cleanup'
import { createGoogleCredentialStore } from './google-credential-store'
import { createGoogleConnectionManager } from './google-connection-manager'
import { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { GoogleConnectionFailureCode } from './google-connection'
import type { GoogleWebIdentityFailureReason } from './google-web-identity'
import { loadRuntimeGoogleOAuthConfig } from './google-oauth-runtime-config'
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
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_REMOVE_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  GOOGLE_CONNECTION_CANCEL_CHANNEL,
  GOOGLE_CONNECTION_CONNECT_CHANNEL,
  GOOGLE_CONNECTION_DISCONNECT_CHANNEL,
  GOOGLE_CONNECTION_STATUS_CHANNEL,
  type AppInfo
} from '../shared/ipc'
import {
  isAllowedAccountRequest,
  isAllowedAppInfoRequest,
  isAllowedExternalUrl,
  isAllowedGoogleConnectionRequest,
  isTrustedRendererUrl
} from './security-policy'

app.setName('Hantong')

const rendererFile = join(__dirname, '../renderer/index.html')
const rendererUrl =
  is.dev && process.env['ELECTRON_RENDERER_URL']
    ? process.env['ELECTRON_RENDERER_URL']
    : pathToFileURL(rendererFile).href

let mainWindow: BrowserWindow | null = null
let accountStore: ReturnType<typeof createAccountStore> | null = null
let accountViewManager: ReturnType<typeof createAccountViewManager> | null = null
let accountRemoval: ReturnType<typeof createAccountRemovalController> | null = null
let googleConnectionRuntime: ReturnType<typeof createGoogleConnectionRuntime> | null = null
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
  const window = new BrowserWindow({
    title: 'Hantong',
    width: 1000,
    height: 720,
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
  const windowViewManager = createAccountViewManager(
    window,
    requireAccountStore(),
    (status) => {
      if (!window.isDestroyed()) window.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, status)
    },
    (url) => shell.openExternal(url),
    30_000,
    (reason) => reportOAuthDiagnostic('identity', reason)
  )
  accountViewManager = windowViewManager

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
    void googleConnectionRuntime?.cancelAll().catch(() => {
      console.error('Unable to cancel pending Google connections')
    })
    void windowViewManager.dispose().catch(() => {
      console.error('Unable to close Gmail views')
    })
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
    googleConnectionRuntime = createGoogleConnectionRuntime({
      accountExists: (id) =>
        requireAccountStore()
          .getState()
          .accounts.some((account) => account.id === id),
      readWebIdentity: (id, signal) =>
        accountViewManager?.readWebIdentity(id, signal) ?? Promise.resolve(null),
      loadConfig: () =>
        loadRuntimeGoogleOAuthConfig({
          environment: process.env,
          isPackaged: app.isPackaged,
          localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env')
        }),
      startAuthorization: (config) =>
        startGoogleAuthorization(config, {
          openExternal: (url) => shell.openExternal(url),
          reportFailure: (code) => reportOAuthDiagnostic('authorization', code)
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
      reportFailure: (stage, code) => reportOAuthDiagnostic(stage, code)
    })
    accountRemoval = createAccountRemovalController(
      requireAccountStore(),
      clearAccountSession,
      async (id) => {
        const result = await requireGoogleConnectionRuntime().disconnect(id)
        if (result.status === 'error') throw new Error('Unable to disconnect Google API')
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
      operation: 'get' | 'add' | 'activate' | 'retry' | 'remove',
      args: unknown[]
    ): boolean {
      const owner = mainWindow
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const id = args.length === 1 && typeof args[0] === 'string' ? args[0] : ''
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
          operation === 'activate' || operation === 'remove'
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
        const result =
          operation === 'get'
            ? await runtime.getStatus(accountId)
            : operation === 'connect'
              ? await runtime.connect(accountId)
              : operation === 'cancel'
                ? await runtime.cancel(accountId)
                : await runtime.disconnect(accountId)
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
        async confirm(accountNumber): Promise<boolean> {
          if (!ownerIsAlive()) return false
          const isKorean = app.getLocale().startsWith('ko')
          const accountLabel = `Gmail ${accountNumber}`
          const response = await dialog.showMessageBox(owner, {
            type: 'warning',
            title: isKorean ? '계정 삭제' : 'Remove account',
            message: isKorean
              ? `${accountLabel} 계정을 한통에서 삭제할까요?`
              : `Remove ${accountLabel} from Hantong?`,
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
      void requireGoogleConnectionRuntime()
        .cancelAll()
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
