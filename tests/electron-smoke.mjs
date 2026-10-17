import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'

// Keep the smoke run separate from the user's application data.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'hantong-smoke-')))
const timeout = setTimeout(() => {
  console.error('Electron smoke check timed out')
  app.exit(1)
}, 15000)

app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', () => {
    void verify(window).then(
      () => {
        clearTimeout(timeout)
        console.info('Electron smoke check passed')
        app.exit(0)
      },
      (error) => {
        clearTimeout(timeout)
        console.error(error)
        app.exit(1)
      }
    )
  })
})

// Electron executes this JavaScript entry directly, without a TypeScript loader.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function verify(window) {
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.webviewTag, false)

  const result = await window.webContents.executeJavaScript(`(async () => ({
    node: typeof window.require,
    process: typeof window.process,
    genericBridge: typeof window.electron,
    operations: Object.keys(window.api),
    info: await window.api.getAppInfo(),
    accounts: await window.api.getAccounts(),
    access: await (async () => {
      const accounts = await window.api.getAccounts()
      return accounts.activeAccountId
        ? window.api.getAccountAccessState(accounts.activeAccountId)
        : null
    })(),
    permission: (await navigator.permissions.query({ name: 'geolocation' })).state
  }))()`)
  assert.equal(result.node, 'undefined')
  assert.equal(result.process, 'undefined')
  assert.equal(result.genericBridge, 'undefined')
  assert.deepEqual(result.operations, [
    'getAppInfo',
    'getGoogleConnectionStatus',
    'connectGoogleAccount',
    'cancelGoogleConnection',
    'disconnectGoogleAccount',
    'getAccounts',
    'addAccount',
    'activateAccount',
    'setAccountDisplayName',
    'setDefaultAccount',
    'retryAccount',
    'removeAccount',
    'onAccountViewStatus',
    'getAccountAccessState',
    'onAccountAccessState'
  ])
  assert.equal(result.info.name, 'Hantong')
  assert.equal(typeof result.info.version, 'string')
  assert.ok(['ko', 'en'].includes(result.info.locale))
  assert.deepEqual(result.accounts, {
    version: 1,
    accounts: [],
    activeAccountId: null,
    defaultAccountId: null
  })
  assert.equal(result.access, null)
  assert.equal(result.permission, 'denied')

  const originalUrl = window.webContents.getURL()
  const navigated = new Promise((resolve) => {
    window.webContents.once('will-frame-navigate', resolve)
  })
  await window.webContents.executeJavaScript(
    "window.location.href = 'file:///hantong-blocked.html'"
  )
  await navigated
  assert.equal(window.webContents.getURL(), originalUrl)

  const count = BrowserWindow.getAllWindows().length
  await window.webContents.executeJavaScript("window.open('javascript:void(0)')")
  assert.equal(BrowserWindow.getAllWindows().length, count)
}

await import('../out/main/index.js')
