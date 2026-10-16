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
  const resolvers = []
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
      accounts: [{ id: firstId }, { id: secondId }],
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
          }
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
    loadTimeoutMs
  )
  return {
    manager,
    created,
    attached,
    detached,
    statuses,
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
  assert.equal(attached.length, 3)
  assert.equal(detached.length, 2)
  await manager.dispose()
  assert.equal(created[0].disposeCount, 1)
  assert.equal(created[1].disposeCount, 1)
})

test('inactive load completion is cached and the view stays below the fixed chrome', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.attached.length, 1)
  assert.equal(fixtureData.created[0].view.bounds.y, 88)
  fixtureData.resize()
  assert.equal(fixtureData.created[0].view.boundsCount, 2)
  await fixtureData.manager.activate(secondId)
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.created[0].loads, 1)
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'ready'
  })
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
  fixtureData.created[0].view.webContents.emit('render-process-gone')
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

test('removing one account view invalidates it without disposing another account', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  await fixtureData.manager.activate(secondId)
  await fixtureData.manager.disposeAccount(firstId)
  assert.equal(fixtureData.created[0].disposeCount, 1)
  assert.equal(fixtureData.created[1].disposeCount, 0)
  await fixtureData.manager.activate(firstId)
  assert.equal(fixtureData.created.length, 3)
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
