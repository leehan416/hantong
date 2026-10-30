/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'
import { firstId, secondId, fixture } from './helpers/account-view-fixture.mjs'

const { createAccountAccessController } = loadTypeScript(
  new URL('../src/main/account-access-controller.ts', import.meta.url)
)

test('views are created only when visited, reused on switch, and removed when inactive', async () => {
  const { manager, created, attached, detached } = fixture()
  await manager.activate(firstId)
  assert.equal(created.length, 1)
  assert.equal(created[0].loads, 1)
  await manager.activate(secondId)
  await manager.activate(firstId)
  assert.equal(created.length, 2)
  assert.equal(created[0].loads, 1)
  assert.equal(attached.length, 0)
  assert.equal(detached.length, 0)
  await manager.dispose()
  assert.equal(created[0].disposeCount, 1)
  assert.equal(created[1].disposeCount, 1)
})

test('unavailable view identity keeps the stored account distinct from a deleted account', async () => {
  const fixtureData = fixture()
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  fixtureData.accounts.splice(0, 1)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: false,
    emailAddress: null
  })
  await fixtureData.manager.dispose()
})

test('inactive load completion is cached and the view stays below the fixed chrome', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/ServiceLogin'
  )
  assert.equal(fixtureData.attached.length, 0)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/Logout?continue=mail'
  await fixtureData.manager.activate(secondId)
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.attached.length, 1)
  assert.equal(fixtureData.created[0].view.bounds.y, 72)
  fixtureData.manager.setLayout('left', false)
  assert.deepEqual(structuredClone(fixtureData.created[0].view.bounds), {
    x: 248,
    y: 32,
    width: 652,
    height: 668
  })
  fixtureData.manager.setLayout('right', true)
  assert.deepEqual(structuredClone(fixtureData.created[0].view.bounds), {
    x: 0,
    y: 32,
    width: 844,
    height: 668
  })
  fixtureData.manager.setStatusStripVisible(false)
  assert.deepEqual(structuredClone(fixtureData.created[0].view.bounds), {
    x: 0,
    y: 0,
    width: 844,
    height: 700
  })
  fixtureData.manager.setStatusStripVisible(true)
  assert.deepEqual(structuredClone(fixtureData.created[0].view.bounds), {
    x: 0,
    y: 32,
    width: 844,
    height: 668
  })
  fixtureData.resize()
  assert.equal(fixtureData.created[0].view.boundsCount, 7)
  assert.equal(fixtureData.created[0].loads, 1)
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'ready'
  })
  await fixtureData.manager.dispose()
})

test('mail view stays detached until Main grants access and sign-in remains visible', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.attached.length, 0)
  assert.deepEqual(structuredClone(fixtureData.manager.getDocumentState(firstId)), {
    revision: 0,
    kind: 'mail',
    ready: true
  })
  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/ServiceLogin'
  )
  assert.equal(fixtureData.attached.length, 0)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/Logout?continue=mail'
  })
  fixtureData.created[0].view.webContents.emit('did-frame-finish-load', {}, true)
  fixtureData.created[0].view.webContents.emit('did-stop-loading')
  assert.equal(fixtureData.attached.length, 1)
  fixtureData.created[0].view.webContents.url = 'https://mail.google.com/mail/u/0/'
  fixtureData.created[0].view.callbacks.onMainFrameNavigation('https://mail.google.com/mail/u/0/')
  assert.equal(fixtureData.detached.length, 1)
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://mail.google.com/mail/u/0/'
  })
  fixtureData.created[0].view.webContents.emit('did-frame-finish-load', {}, true)
  fixtureData.created[0].view.webContents.emit('did-stop-loading')
  const state = fixtureData.manager.getDocumentState(firstId)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, state.revision), true)
  assert.equal(fixtureData.attached.length, 2)
  const grantedRevision = fixtureData.manager.getDocumentState(firstId).revision
  fixtureData.created[0].view.webContents.url = 'https://mail.google.com/mail/u/0/#inbox'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
    url: 'https://mail.google.com/mail/u/0/#inbox'
  })
  assert.equal(fixtureData.manager.getDocumentState(firstId).revision, grantedRevision)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, grantedRevision), true)
  fixtureData.created[0].view.webContents.url = 'https://mail.google.com/mail/u/1/#inbox'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
    url: 'https://mail.google.com/mail/u/1/#inbox'
  })
  assert.equal(fixtureData.manager.getDocumentState(firstId).revision > grantedRevision, true)
  assert.equal(fixtureData.detached.length, 2)
  assert.equal(fixtureData.manager.setMailAccess(firstId, false), true)
  assert.equal(fixtureData.detached.length, 2)
  await fixtureData.manager.dispose()
})

test('cached Gmail view receives usable bounds before its first load while remaining detached', async () => {
  let loadStartBounds
  let attachedAtLoadStart
  const fixtureData = fixture({
    onLoadStart: (view) => {
      loadStartBounds = view.bounds
      attachedAtLoadStart = fixtureData.attached.length
    }
  })
  await fixtureData.manager.activate(firstId)
  assert.deepEqual(structuredClone(loadStartBounds), {
    x: 0,
    y: 72,
    width: 900,
    height: 628
  })
  assert.equal(attachedAtLoadStart, 0)
  assert.deepEqual(structuredClone(fixtureData.created[0].view.bounds), {
    x: 0,
    y: 72,
    width: 900,
    height: 628
  })
  assert.equal(fixtureData.attached.length, 0)
  assert.equal(fixtureData.created[0].loads, 1)
  await fixtureData.manager.dispose()
})

test('covering an attached mailbox captures its current bounds before detaching and restores it', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 0), true)
  fixtureData.manager.setLayout('right', true)
  fixtureData.manager.setStatusStripVisible(false)
  const snapshot = await fixtureData.manager.setCovered(true)
  assert.deepEqual(structuredClone(snapshot), {
    accountId: firstId,
    bounds: { x: 0, y: 0, width: 844, height: 700 },
    dataUrl: 'data:image/png;base64,bWFpbA=='
  })
  assert.equal(fixtureData.detached.length, 1)
  fixtureData.manager.setCovered(false)
  assert.equal(fixtureData.attached.length, 2)
  await fixtureData.manager.dispose()
})

test('snapshot failure still covers the mailbox and a later close restores its live view', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 0), true)
  fixtureData.created[0].view.webContents.capturePage = async () => {
    throw new Error('capture unavailable')
  }
  assert.equal(await fixtureData.manager.setCovered(true), null)
  assert.equal(fixtureData.detached.length, 1)
  await fixtureData.manager.setCovered(false)
  assert.equal(fixtureData.attached.length, 2)
  await fixtureData.manager.dispose()
})

test('removing one account view invalidates it without disposing another account', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  await fixtureData.manager.activate(secondId)
  const removedWebContents = fixtureData.created[0].view.webContents
  removedWebContents.loadingMainFrame = true
  removedWebContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  await fixtureData.manager.disposeAccount(firstId)
  assert.equal(fixtureData.created[0].disposeCount, 1)
  assert.equal(fixtureData.created[1].disposeCount, 0)
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.created.length, 3)
  removedWebContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  const statusCount = fixtureData.statuses.length
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.statuses.length, statusCount)
  await fixtureData.manager.dispose()
})

test('logout needs an established view, a successful request, and ready sign-in evidence', async () => {
  const removed = []
  const fixtureData = fixture({ onExplicitLogout: (id) => removed.push(id) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 0), true)
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(91)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/ServiceLogin'
  })
  fixtureData.created[0].view.webContents.emit('dom-ready')
  assert.deepEqual(removed, [])
  callbacks.onLogoutRequestSuccess(91)
  assert.deepEqual(removed, [firstId])
  callbacks.onLogoutRequestSuccess(91)
  assert.deepEqual(removed, [firstId])
  await fixtureData.manager.dispose()
})

test('logout completion before sign-in readiness is supported and cleanup failure stays locked', async () => {
  const removed = []
  const fixtureData = fixture({ onExplicitLogout: (id) => removed.push(id) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const callbacks = fixtureData.created[0].view.callbacks
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/Logout?continue=mail'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/Logout?continue=mail'
  })
  callbacks.onLogoutRequestStart(92)
  callbacks.onLogoutRequestSuccess(92)
  assert.deepEqual(removed, [])
  fixtureData.created[0].view.webContents.loadingMainFrame = true
  fixtureData.created[0].view.webContents.emit('dom-ready')
  fixtureData.created[0].view.webContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(removed, [])
  fixtureData.created[0].view.webContents.loadingMainFrame = false
  fixtureData.created[0].view.webContents.emit('did-stop-loading')
  assert.deepEqual(removed, [firstId])
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)
  assert.equal(fixtureData.manager.clearLogoutLock(firstId), false)
  await fixtureData.manager.dispose()
})

test('failed logout is a reconnectable access error and explicit connect reloads an unloaded mail view', async () => {
  let access
  const accessStates = []
  let oauthStarts = 0
  let failReload = false
  const fixtureData = fixture({
    onExplicitLogout: () => 'removed',
    onLoadStart: (view) => {
      view.webContents.url = 'https://mail.google.com/mail/u/0/'
      if (failReload) {
        failReload = false
        throw new Error('offline reload')
      }
    },
    onStatus: (status) => {
      if (access && ['loading', 'ready', 'blocked', 'error'].includes(status.status))
        access.onViewReady(status.accountId)
    }
  })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  access = createAccountAccessController({
    views: fixtureData.manager,
    runtime: {
      getStatus: async () => ({ status: 'connected' }),
      connect: async () => {
        oauthStarts += 1
        return { status: 'connected' }
      },
      cancel: async () => ({ status: 'disconnected' }),
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({ status: 'connected', emailAddress: 'private@example.com' }),
      getGeneration: () => 1,
      getAccessToken: async () => 'opaque-token'
    },
    loadConfig: () => ({}),
    fetchProfile: async () => 'private@example.com',
    accountExists: (id) => fixtureData.accounts.some((account) => account.id === id),
    onWebIdentity: () => undefined,
    publish: (state) => accessStates.push(structuredClone(state))
  })
  access.onViewReady(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'ready')
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(130)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/Logout'
  fixtureData.created[0].view.webContents.loadingMainFrame = true
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/Logout'
  })
  fixtureData.created[0].view.webContents.loadingMainFrame = false
  fixtureData.created[0].view.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'offline',
    'https://accounts.google.com/Logout',
    true
  )
  callbacks.onLogoutRequestFailure(130)
  assert.equal(access.getState(firstId).status, 'error')
  assert.equal(access.getState(firstId).connectionStatus, 'reconnect_required')
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)

  const handle = fixtureData.created[0]
  failReload = true
  const loadsBeforeReconnect = handle.loads
  await access.connect(firstId)
  assert.equal(handle.loads, loadsBeforeReconnect + 1)
  for (let attempt = 0; attempt < 10 && access.getState(firstId).status !== 'error'; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'error')
  assert.equal(access.getState(firstId).connectionStatus, 'reconnect_required')

  await fixtureData.manager.activate(secondId)
  await new Promise((resolve) => setImmediate(resolve))
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'error')

  const loadsBeforeSecondReconnect = handle.loads
  await access.connect(firstId)
  assert.ok(handle.loads >= loadsBeforeSecondReconnect)
  for (let attempt = 0; attempt < 10 && access.getState(firstId).status !== 'ready'; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'ready')
  assert.equal(fixtureData.manager.getDocumentState(firstId).ready, true)
  assert.equal(oauthStarts, 0)
  assert.ok(accessStates.some((state) => state.status === 'error'))
  callbacks.onLogoutRequestFailure(130)
  assert.equal(access.getState(firstId).status, 'ready')
  callbacks.onLogoutRequestStart(134)
  callbacks.onLogoutRequestFailure(130)
  assert.equal(access.getState(firstId).status, 'checking')
  callbacks.onLogoutRequestFailure(134)
  assert.equal(access.getState(firstId).status, 'error')
  access.dispose()
  await fixtureData.manager.dispose()
})

test('failed logout detaches a loaded sign-in view so the reconnect gate remains visible', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const { callbacks, webContents } = fixtureData.created[0].view
  callbacks.onLogoutRequestStart(132)
  webContents.url = 'https://accounts.google.com/ServiceLogin'
  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/ServiceLogin'
  })
  webContents.loadingMainFrame = false
  webContents.emit('did-frame-finish-load', {}, true)
  assert.equal(fixtureData.attached.length, 2)
  callbacks.onLogoutRequestFailure(132)
  assert.equal(fixtureData.detached.length, 2)
  assert.equal(fixtureData.manager.getDocumentState(firstId).logoutFailed, true)
  const access = createAccountAccessController({
    views: fixtureData.manager,
    runtime: {
      getStatus: async () => ({ status: 'disconnected' }),
      connect: async () => ({ status: 'connected' }),
      cancel: async () => ({ status: 'disconnected' }),
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({ status: 'disconnected' }),
      getGeneration: () => 1,
      getAccessToken: async () => 'opaque-token'
    },
    loadConfig: () => ({}),
    fetchProfile: async () => 'private@example.com',
    accountExists: (id) => fixtureData.accounts.some((account) => account.id === id),
    onWebIdentity: () => undefined,
    publish: () => undefined
  })
  const result = await access.connect(firstId)
  assert.equal(result.status, 'sign_in')
  assert.equal(fixtureData.attached.length, 3)
  assert.equal(fixtureData.manager.getDocumentState(firstId).kind, 'sign_in')
  access.dispose()
  await fixtureData.manager.dispose()
})

test('failed logout error survives view notifications and account switching', async () => {
  let access
  let oauthStarts = 0
  const fixtureData = fixture({
    onStatus: (status) => {
      if (access && ['loading', 'ready', 'blocked', 'error'].includes(status.status))
        access.onViewReady(status.accountId)
    }
  })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  access = createAccountAccessController({
    views: fixtureData.manager,
    runtime: {
      getStatus: async () => ({ status: 'connected' }),
      connect: async () => {
        oauthStarts += 1
        return { status: 'connected' }
      },
      cancel: async () => ({ status: 'disconnected' }),
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({ status: 'connected', emailAddress: 'private@example.com' }),
      getGeneration: () => 1,
      getAccessToken: async () => 'opaque-token'
    },
    loadConfig: () => ({}),
    fetchProfile: async () => 'private@example.com',
    accountExists: (id) => fixtureData.accounts.some((account) => account.id === id),
    onWebIdentity: () => undefined,
    publish: () => undefined
  })
  access.onViewReady(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'ready')
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(133)
  callbacks.onLogoutRequestFailure(133)
  assert.equal(access.getState(firstId).status, 'error')
  assert.equal(access.getState(firstId).connectionStatus, 'reconnect_required')
  callbacks.onNavigationBlocked({
    source: 'redirect',
    context: 'main',
    hostname: 'mail.google.com',
    route: 'other',
    reason: 'external_redirect'
  })
  assert.equal(fixtureData.manager.getDocumentState(firstId).loaded, false)

  await fixtureData.manager.activate(secondId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'error')
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'error')
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)
  const loadsBeforeRetry = fixtureData.created[0].loads
  await access.connect(firstId)
  assert.equal(fixtureData.created[0].loads, loadsBeforeRetry + 1)
  for (let attempt = 0; attempt < 10 && access.getState(firstId).status !== 'ready'; attempt += 1)
    await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'ready')
  assert.equal(oauthStarts, 0)
  access.dispose()
  await fixtureData.manager.dispose()
})

test('successful tracked logout plus blocked workspace redirect confirms removal in either event order', async () => {
  for (const redirectFirst of [true, false]) {
    const removed = []
    const fixtureData = fixture({ onExplicitLogout: (id) => removed.push(id) })
    await fixtureData.manager.activate(firstId)
    await new Promise((resolve) => setImmediate(resolve))
    fixtureData.manager.setMailAccess(firstId, true, 0)
    const { callbacks, webContents } = fixtureData.created[0].view
    callbacks.onLogoutRequestStart(121)
    webContents.url = 'https://mail.google.com/mail/u/0/'
    callbacks.onMainFrameNavigation(webContents.url)
    webContents.url = 'https://workspace.google.com/'
    callbacks.onMainFrameNavigation(webContents.url)
    if (redirectFirst) assert.equal(callbacks.onLogoutTerminalRedirect(), true)
    callbacks.onLogoutRequestSuccess(121)
    if (!redirectFirst) assert.equal(callbacks.onLogoutTerminalRedirect(), true)
    assert.deepEqual(removed, [firstId])
    await fixtureData.manager.dispose()
  }
})

test('workspace terminal evidence cannot outlive failure, reconnect, or view replacement', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const stale = fixtureData.created[0].view.callbacks
  stale.onLogoutRequestStart(122)
  assert.equal(stale.onLogoutTerminalRedirect(), true)
  stale.onLogoutRequestFailure(122)
  assert.equal(stale.onLogoutTerminalRedirect(), false)
  assert.equal(fixtureData.manager.clearLogoutLock(firstId), true)
  stale.onLogoutRequestStart(123)
  await fixtureData.manager.disposeAccount(firstId)
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stale.onLogoutTerminalRedirect(), false)
  assert.equal(fixtureData.manager.getDocumentState(firstId).ready, false)
  await fixtureData.manager.dispose()
})

test('sign-in alone and logout from an unestablished account do not remove it', async () => {
  const removed = []
  const fixtureData = fixture({ onExplicitLogout: (id) => removed.push(id) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(93)
  callbacks.onLogoutRequestSuccess(93)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
  fixtureData.created[0].view.webContents.emit('dom-ready')
  assert.deepEqual(removed, [])
  await fixtureData.manager.dispose()
})

test('failed logout stays locked until explicit reconnect clears the unconfirmed attempt', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 0), true)
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(94)
  callbacks.onLogoutRequestFailure(94)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)
  assert.equal(fixtureData.manager.clearLogoutLock(firstId), true)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), true)
  await fixtureData.manager.dispose()
})

test('confirmed logout lock survives view recreation after failed account cleanup', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(95)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/ServiceLogin'
  })
  fixtureData.created[0].view.webContents.emit('dom-ready')
  callbacks.onLogoutRequestSuccess(95)
  await fixtureData.manager.disposeAccount(firstId)
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.manager.getDocumentState(firstId).ready, false)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 0), false)
  assert.equal(fixtureData.manager.clearLogoutLock(firstId), false)
  await fixtureData.manager.dispose()
})

test('stale logout callbacks from a disposed view cannot remove a recreated account', async () => {
  const removed = []
  const fixtureData = fixture({ onExplicitLogout: (id) => removed.push(id) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const staleCallbacks = fixtureData.created[0].view.callbacks
  await fixtureData.manager.disposeAccount(firstId)
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  staleCallbacks.onLogoutRequestStart(96)
  staleCallbacks.onLogoutRequestSuccess(96)
  staleCallbacks.onLogoutRequestFailure(96)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/ServiceLogin'
  })
  fixtureData.created[0].view.webContents.emit('dom-ready')
  assert.deepEqual(removed, [])
  assert.equal(fixtureData.manager.getDocumentState(firstId).logoutFailed, undefined)
  await fixtureData.manager.dispose()
})

test('logout flow diagnostics identify readiness and removal outcomes without page data', async () => {
  const diagnostics = []
  const fixtureData = fixture({ onLogoutDiagnostic: (record) => diagnostics.push(record) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  const callbacks = fixtureData.created[0].view.callbacks
  callbacks.onLogoutRequestStart(97)
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/Logout?secret=value'
  fixtureData.created[0].view.webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/Logout?secret=value'
  })
  callbacks.onLogoutRequestSuccess(97)
  fixtureData.created[0].view.webContents.loadingMainFrame = true
  fixtureData.created[0].view.webContents.emit('dom-ready')
  fixtureData.created[0].view.webContents.loadingMainFrame = false
  fixtureData.created[0].view.webContents.emit('did-stop-loading')
  await new Promise((resolve) => setImmediate(resolve))
  const stages = diagnostics.map(({ stage, outcome }) => [stage, outcome])
  assert.deepEqual(stages, [
    ['confirmation', 'waiting_for_ready_sign_in'],
    ['readiness', 'document_loading'],
    ['readiness', 'ready'],
    ['confirmation', 'confirmed'],
    ['removal', 'started'],
    ['removal', 'skipped']
  ])
  assert.equal(JSON.stringify(diagnostics).includes('accounts.google.com'), false)
  assert.equal(JSON.stringify(diagnostics).includes('secret'), false)
  await fixtureData.manager.dispose()
})

test('late readiness callbacks do not read a disposed WebContents', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.manager.setMailAccess(firstId, true, 0)
  fixtureData.created[0].view.callbacks.onLogoutRequestStart(98)
  const contents = fixtureData.created[0].view.webContents
  const staleReady = contents.listeners('dom-ready').at(-1)
  await fixtureData.manager.disposeAccount(firstId)
  contents.isDestroyed = () => true
  contents.getURL = () => {
    throw new Error('disposed contents must not be read')
  }
  contents.isLoadingMainFrame = () => {
    throw new Error('disposed contents must not be read')
  }
  assert.doesNotThrow(() => staleReady())
  await fixtureData.manager.dispose()
})

test('inactive main-frame document and account-slot changes invalidate verification', async () => {
  const invalidated = []
  const fixtureData = fixture({ onAccessInvalidated: (id) => invalidated.push(id) })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  await fixtureData.manager.activate(secondId)
  const contents = fixtureData.created[0].view.webContents
  contents.url = 'https://mail.google.com/mail/u/0/#inbox'
  contents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
    url: contents.url
  })
  assert.deepEqual(invalidated, [])
  contents.url = 'https://mail.google.com/mail/u/1/#inbox'
  contents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
    url: contents.url
  })
  assert.deepEqual(invalidated, [firstId])
  contents.url = 'https://mail.google.com/mail/u/1/settings'
  contents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: contents.url
  })
  assert.deepEqual(invalidated, [firstId, firstId])
  await fixtureData.manager.dispose()
})

test('same-document account-slot invalidation precedes ready revalidation', async () => {
  const { createAccountAccessController } = loadTypeScript(
    new URL('../src/main/account-access-controller.ts', import.meta.url)
  )
  let access
  let profileReads = 0
  const fixtureData = fixture({
    onAccessInvalidated: (id) => access?.invalidate(id),
    onStatus: (status) => {
      if (status.status === 'ready') access?.onViewReady(status.accountId)
    }
  })
  access = createAccountAccessController({
    views: fixtureData.manager,
    runtime: {
      getStatus: async () => ({ status: 'connected' }),
      connect: async () => ({ status: 'connected' }),
      cancel: async () => ({ status: 'disconnected' }),
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({ status: 'connected', emailAddress: 'private@example.com' }),
      getGeneration: () => 1,
      getAccessToken: async () => 'test-token'
    },
    loadConfig: () => ({}),
    fetchProfile: async () => {
      profileReads += 1
      return 'private@example.com'
    },
    accountExists: (id) => fixtureData.accounts.some((account) => account.id === id),
    onWebIdentity: () => undefined,
    publish: () => undefined
  })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(access.getState(firstId).status, 'ready')
  assert.equal(profileReads, 1)

  const contents = fixtureData.created[0].view.webContents
  contents.url = 'https://mail.google.com/mail/u/1/#inbox'
  contents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true,
    url: contents.url
  })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(profileReads, 2)
  assert.equal(access.getState(firstId).status, 'ready')
  access.dispose()
  await fixtureData.manager.dispose()
})

test('retry recreates a retained active account after failed cleanup disposed its view', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await fixtureData.manager.disposeAccount(firstId)
  const priorCount = fixtureData.created.length
  fixtureData.manager.retry()
  assert.equal(fixtureData.created.length, priorCount + 1)
  assert.equal(fixtureData.created.at(-1).loads, 1)
  await fixtureData.manager.dispose()
})

test('covering the window detaches the granted mail view and uncovering restores it', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const state = fixtureData.manager.getDocumentState(firstId)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, state.revision), true)
  assert.equal(fixtureData.attached.length, 1)
  await fixtureData.manager.setCovered(true)
  assert.equal(fixtureData.detached.length, 1)
  // Switching accounts while covered must not bring a view back on top of the panel.
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.attached.length, 1)
  await fixtureData.manager.setCovered(false)
  assert.equal(fixtureData.attached.length, 2)
  await fixtureData.manager.dispose()
})
