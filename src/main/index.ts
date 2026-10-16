import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createAccountStore } from './account-store'
import { createAccountViewManager } from './account-view-manager'
import { is, optimizer } from '@electron-toolkit/utils'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  type AppInfo
} from '../shared/ipc'
import {
  isAllowedAccountRequest,
  isAllowedAppInfoRequest,
  isAllowedExternalUrl,
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
  accountViewManager = createAccountViewManager(
    window,
    requireAccountStore(),
    (status) => {
      if (!window.isDestroyed()) window.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, status)
    },
    (url) => shell.openExternal(url)
  )

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
    accountViewManager?.dispose()
    accountViewManager = null
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
      operation: 'get' | 'add' | 'activate' | 'retry',
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
          operation === 'activate'
            ? state.accounts.some((account) => account.id === id)
            : operation === 'retry' && state.activeAccountId !== null
      })
    }

    ipcMain.handle(ACCOUNT_STATE_CHANNEL, (event, ...args: unknown[]) => {
      if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
      const state = requireAccountStore().getState()
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_ADD_CHANNEL, (event, ...args: unknown[]) => {
      if (!accountRequestAllowed(event, 'add', args)) throw new Error('Request rejected')
      const state = requireAccountStore().add()
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_ACTIVATE_CHANNEL, (event, ...args: unknown[]) => {
      if (!accountRequestAllowed(event, 'activate', args)) throw new Error('Request rejected')
      const id = args[0]
      if (typeof id !== 'string') throw new Error('Request rejected')
      const state = requireAccountStore().activate(id)
      if (state.activeAccountId) activateAccountView(state.activeAccountId)
      return state
    })
    ipcMain.handle(ACCOUNT_RETRY_CHANNEL, (event, ...args: unknown[]) => {
      if (!accountRequestAllowed(event, 'retry', args)) throw new Error('Request rejected')
      accountViewManager?.retry()
    })

    createWindow()
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
