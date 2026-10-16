import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is, optimizer } from '@electron-toolkit/utils'
import { APP_INFO_CHANNEL, type AppInfo } from '../shared/ipc'
import {
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
    if (mainWindow === window) mainWindow = null
  })
  optimizer.watchWindowShortcuts(window)

  void contents.loadURL(rendererUrl).catch(() => {
    console.error('Unable to load the Hantong window')
    window.destroy()
    app.quit()
  })
}

void app
  .whenReady()
  .then(() => {
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
