/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstId, secondId, fixture } from './helpers/account-view-fixture.mjs'

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
  fixtureData.created[0].view.webContents.url = 'https://accounts.google.com/ServiceLogin'
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
    url: 'https://accounts.google.com/ServiceLogin'
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
