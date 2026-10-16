/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these JavaScript test doubles without a TypeScript loader. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

function fixture({ allowed = false } = {}) {
  const opened = []
  let blocked = 0
  const webSession = {
    setPermissionCheckHandler(handler) {
      this.checkPermission = handler
    },
    setPermissionRequestHandler(handler) {
      this.requestPermission = handler
    }
  }
  class Contents extends EventEmitter {
    destroyed = false
    loads = []
    setWindowOpenHandler(handler) {
      this.openWindow = handler
    }
    async loadURL(url) {
      this.loads.push(url)
    }
    isDestroyed() {
      return this.destroyed
    }
    close() {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  class View {
    constructor(options) {
      this.options = options
      this.webContents = new Contents()
    }
  }
  const { createGmailView } = loadTypeScript(
    new URL('../src/main/gmail-view.ts', import.meta.url),
    {
      electron: { WebContentsView: View }
    }
  )
  const handle = createGmailView(webSession, {
    openExternal: async (url) => {
      opened.push(url)
    },
    onNavigationBlocked: () => {
      blocked += 1
    },
    onMainFrameNavigation: (url) => navigated.push(url),
    isMailAccessAllowed: () => allowed
  })
  const navigated = []
  return { handle, webSession, opened, blocked: () => blocked, navigated }
}

test('creating a Gmail view grants no Node or preload access and does not load eagerly', async () => {
  const { handle, webSession } = fixture()
  const preferences = handle.view.options.webPreferences
  assert.equal(preferences.session, webSession)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.nodeIntegrationInSubFrames, false)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.webviewTag, false)
  assert.equal(preferences.preload, undefined)
  assert.equal(handle.view.webContents.loads.length, 0)
  await handle.load()
  assert.deepEqual(handle.view.webContents.loads, ['https://mail.google.com/'])
})

test('both permission paths deny external content access', () => {
  const { webSession } = fixture()
  assert.equal(webSession.checkPermission(null, 'media', 'https://mail.google.com'), false)
  let granted
  webSession.requestPermission(null, 'notifications', (value) => {
    granted = value
  })
  assert.equal(granted, false)
})

test('external navigation is cancelled and opened outside the Gmail session', () => {
  const { handle, opened } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-frame-navigate', {
    url: 'https://example.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.deepEqual(opened, ['https://example.com/'])
})

test('redirects cannot launch the system browser or leave the trusted hosts', () => {
  const { handle, opened, blocked } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://example.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.deepEqual(opened, [])
  assert.equal(blocked(), 1)
})

test('authentication popups share the session and inherit the navigation guards', async () => {
  const { handle, webSession, opened } = fixture({ allowed: true })
  const response = handle.view.webContents.openWindow({
    url: 'https://accounts.google.com/ServiceLogin'
  })
  assert.equal(response.action, 'allow')
  const preferences = response.overrideBrowserWindowOptions.webPreferences
  assert.equal(preferences.session, webSession)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.preload, undefined)
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  let destroyed = false
  child.destroy = () => {
    destroyed = true
    child.webContents.destroyed = true
    child.webContents.emit('destroyed')
  }
  handle.view.webContents.emit('did-create-window', child)
  assert.equal(child.webContents.openWindow({ url: 'https://example.com/' }).action, 'deny')
  assert.deepEqual(opened, ['https://example.com/'])
  await handle.dispose()
  assert.equal(destroyed, true)
  assert.equal(handle.view.webContents.isDestroyed(), true)
})

test('disposing a Gmail view waits for its webContents destroyed event', async () => {
  const { handle } = fixture()
  let resolveClose
  handle.view.webContents.close = () => {
    resolveClose = () => {
      handle.view.webContents.destroyed = true
      handle.view.webContents.emit('destroyed')
    }
  }
  let finished = false
  const disposal = handle.dispose().then(() => {
    finished = true
  })
  await Promise.resolve()
  assert.equal(finished, false)
  resolveClose()
  await disposal
  assert.equal(finished, true)
})

test('OAuth and dangerous popup targets are blocked without leaving the app', () => {
  const { handle, opened, blocked } = fixture()
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth', 'javascript:alert(1)']) {
    assert.equal(handle.view.webContents.openWindow({ url }).action, 'deny')
  }
  assert.deepEqual(opened, [])
  assert.equal(blocked(), 2)
})

test('locked parent allows Gmail login redirects while remaining closed to mail popups', () => {
  const { handle, navigated } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://mail.google.com/mail/u/0/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, false)
  assert.deepEqual(navigated, ['https://mail.google.com/mail/u/0/'])
  assert.equal(
    handle.view.webContents.openWindow({ url: 'https://mail.google.com/mail/u/0/' }).action,
    'deny'
  )
})
