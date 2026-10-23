/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstId, fixture } from './helpers/account-view-fixture.mjs'

test('a successful Gmail document load restores identity readiness after a mainframe failure', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.loadingMainFrame = false
  webContents.emit('did-fail-load', {}, -105, 'network error', webContents.url, true)
  webContents.emit('did-frame-finish-load', {}, false)
  webContents.emit('did-stop-loading')
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  assert.equal(fixtureData.identityFailures.at(-1), 'view_not_loaded')

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://mail.google.com/mail/u/0/#inbox'
  webContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')

  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  await fixtureData.manager.dispose()
})

test('same-document navigation keeps a ready Gmail identity readable', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true
  })
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  webContents.loadingMainFrame = true
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  assert.equal(fixtureData.identityFailures.at(-1), 'document_loading')
  await fixtureData.manager.dispose()
})

test('sign-in view stays attached while Google navigates between login pages', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents

  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/ServiceLogin'
  )
  webContents.url = 'https://accounts.google.com/ServiceLogin'
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: webContents.url
  })
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.emit('did-stop-loading')
  assert.equal(fixtureData.attached.length, 1)

  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/v3/signin/challenge/pwd'
  )
  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/v3/signin/challenge/pwd'
  })

  assert.equal(fixtureData.detached.length, 0)
  assert.equal(fixtureData.attached.length, 1)
  await fixtureData.manager.dispose()
})

test('a closed owner suppresses stale load completion callbacks', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  const reportedBeforeClose = fixtureData.statuses.length
  fixtureData.window.isDestroyed = () => true
  await fixtureData.manager.dispose()
  fixtureData.resolvers[0]()
  await Promise.resolve()
  assert.equal(fixtureData.statuses.length, reportedBeforeClose)
})

test('renderer crash invalidates an in-flight load before its late success', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  const webContents = fixtureData.created[0].view.webContents
  webContents.emit('render-process-gone')
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  webContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  await fixtureData.manager.dispose()
})

test('blocked navigation clears only after a successful trusted Gmail document load', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const handle = fixtureData.created[0]
  const webContents = handle.view.webContents
  handle.view.callbacks.onNavigationBlocked()
  assert.equal(
    await fixtureData.manager.readWebIdentity(firstId).then((value) => value?.emailAddress),
    null
  )

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://accounts.google.com/signin'
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.equal(fixtureData.identityFailures.at(-1), 'view_blocked')
  assert.equal(fixtureData.statuses.at(-1).status, 'blocked')

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://mail.google.com/mail/u/0/#inbox'
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.equal(
    await fixtureData.manager.readWebIdentity(firstId).then((value) => value?.emailAddress),
    'private@example.com'
  )
  await fixtureData.manager.dispose()
})

test('load timeout reports an error and a late success cannot replace it', async () => {
  const fixtureData = fixture({ deferLoads: true, loadTimeoutMs: 5 })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  await fixtureData.manager.dispose()
})
