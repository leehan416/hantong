/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

function fixture({ deferLoads = false, loadTimeoutMs = 30_000 } = {}) {
  const created = []
  const attached = []
  const detached = []
  const statuses = []
  const identityFailures = []
  const resolvers = []
  const accounts = [{ id: firstId }, { id: secondId }]
  let resizeHandler
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 900, height: 700 }),
    on: (event, listener) => {
      if (event === 'resize') resizeHandler = listener
    },
    contentView: {
      addChildView: (view) => attached.push(view),
      removeChildView: (view) => detached.push(view)
    }
  }
  const store = {
    getState: () => ({
      version: 1,
      accounts,
      activeAccountId: firstId
    })
  }
  const manager = loadTypeScript(new URL('../src/main/account-view-manager.ts', import.meta.url), {
    setTimeout,
    clearTimeout,
    './account-session': { getAccountSession: (id) => id },
    './gmail-view': {
      createGmailView: (session, callbacks) => {
        const webContents = new EventEmitter()
        webContents.url = 'https://mail.google.com/mail/u/0/'
        webContents.loadingMainFrame = false
        webContents.isDestroyed = () => false
        webContents.isLoadingMainFrame = () => webContents.loadingMainFrame
        webContents.getURL = () => webContents.url
        webContents.executeJavaScriptInIsolatedWorld = async () => 'private@example.com'
        const view = {
          session,
          callbacks,
          setBounds(bounds) {
            this.bounds = bounds
            this.boundsCount = (this.boundsCount ?? 0) + 1
          },
          webContents
        }
        const handle = {
          view,
          loads: 0,
          disposeCount: 0,
          load: async () => {
            handle.loads += 1
            if (deferLoads) {
              await new Promise((resolve) => resolvers.push(resolve))
            }
          },
          dispose: () => {
            handle.disposeCount += 1
            return Promise.resolve()
          },
          revokeMailAccess: () => {}
        }
        created.push(handle)
        return handle
      }
    }
  }).createAccountViewManager(
    window,
    store,
    (status) => statuses.push(status),
    async () => {},
    loadTimeoutMs,
    (reason) => identityFailures.push(reason)
  )
  return {
    manager,
    created,
    attached,
    detached,
    statuses,
    identityFailures,
    accounts,
    window,
    resolvers,
    resize: () => resizeHandler?.()
  }
}

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
  assert.equal(fixtureData.created[0].view.bounds.y, 88)
  fixtureData.resize()
  assert.equal(fixtureData.created[0].view.boundsCount, 2)
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

test('covering the window detaches the granted mail view and uncovering restores it', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const state = fixtureData.manager.getDocumentState(firstId)
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, state.revision), true)
  assert.equal(fixtureData.attached.length, 1)
  fixtureData.manager.setCovered(true)
  assert.equal(fixtureData.detached.length, 1)
  // Switching accounts while covered must not bring a view back on top of the panel.
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.attached.length, 1)
  fixtureData.manager.setCovered(false)
  assert.equal(fixtureData.attached.length, 2)
  await fixtureData.manager.dispose()
})
