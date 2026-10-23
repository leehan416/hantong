/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const handlers = new Map()
const { registerMainIpc } = loadTypeScript(new URL('../src/main/main-ipc.ts', import.meta.url), {
  electron: {
    app: { getName: () => 'Hantong', getVersion: () => '1.0', getLocale: () => 'en-US' },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    nativeTheme: {},
    webContents: { getAllWebContents: () => [] }
  }
})
const accountId = '550e8400-e29b-41d4-a716-446655440000'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function fixture(overrides = {}) {
  handlers.clear()
  const owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  const account = { id: accountId }
  const dependencies = {
    rendererUrl: 'file:///app/index.html',
    window: () => owner,
    views: () => null,
    access: () => null,
    notifications: () => null,
    settings: () => null,
    isQuitting: () => false,
    requireAccountStore: () => ({
      getState: () => ({ accounts: [account], activeAccountId: accountId })
    }),
    requireAccountRemoval: () => ({
      isBusy: () => false,
      assertIdle: () => undefined,
      remove: async () => ({ outcome: 'cancelled' })
    }),
    requireGoogleRuntime: () => ({
      getStatus: async () => ({ accountId, status: 'connected' })
    }),
    recovery: {
      clearPending: () => undefined,
      request: async () => undefined,
      hasPending: () => false
    },
    gmailCleanup: { apply: () => undefined },
    unreadCounts: () => ({ unreadCounts: () => new Map() }),
    locale: () => 'en',
    activateView: () => undefined,
    publishAccountState: () => undefined,
    installAppMenu: () => undefined,
    createWindow: () => undefined,
    loginLaunch: {
      getState: async () => ({ supported: true, enabled: false, status: 'disabled' }),
      setEnabled: async (enabled) => ({
        supported: true,
        enabled,
        status: enabled ? 'enabled' : 'disabled'
      })
    },
    ...overrides
  }
  registerMainIpc(dependencies)
  return { owner, account }
}

function invokeEvent(owner, sender = owner.webContents) {
  const frame = { url: 'file:///app/index.html' }
  sender.mainFrame = frame
  return { sender, senderFrame: frame }
}

test('trusted URL from a foreign sender is rejected by IPC ownership checks', () => {
  const { owner } = fixture()
  const handler = handlers.get('hantong:app-info')
  assert.throws(() => handler(invokeEvent(owner, {})), /Request rejected/)
})

test('login launch IPC validates sender and exact arguments before calling its controller', async () => {
  let gets = 0
  const writes = []
  const { owner } = fixture({
    loginLaunch: {
      getState: async () => {
        gets++
        return { supported: true, enabled: false, status: 'disabled' }
      },
      setEnabled: async (enabled) => {
        writes.push(enabled)
        return { supported: true, enabled, status: enabled ? 'enabled' : 'disabled' }
      }
    }
  })
  const get = handlers.get('hantong:login-launch-get')
  const set = handlers.get('hantong:login-launch-set')
  const event = invokeEvent(owner)
  assert.deepEqual(await get(event), {
    supported: true,
    enabled: false,
    status: 'disabled'
  })
  await assert.rejects(get(event, false), /Request rejected/)
  await assert.rejects(set(event), /Request rejected/)
  await assert.rejects(set(event, 'true'), /Request rejected/)
  await assert.rejects(set(event, true, false), /Request rejected/)
  const foreignFrame = { sender: event.sender, senderFrame: { url: event.senderFrame.url } }
  await assert.rejects(set(foreignFrame, true), /Request rejected/)
  await assert.rejects(get(invokeEvent(owner, {})), /Request rejected/)
  assert.equal(gets, 1)
  assert.deepEqual(writes, [])
  await set(event, true)
  await set(event, false)
  assert.deepEqual(writes, [true, false])
})

test('notification preference IPC validates exact arguments and persists through account store', () => {
  let persisted = false
  let published = null
  const { owner } = fixture({
    requireAccountStore: () => ({
      getState: () => ({ accounts: [{ id: accountId }], activeAccountId: accountId }),
      setNotificationsEnabled: (id, enabled) => {
        assert.equal(id, accountId)
        assert.equal(enabled, false)
        persisted = true
        return {
          version: 1,
          accounts: [{ id, notificationsEnabled: enabled }],
          activeAccountId: id
        }
      }
    }),
    publishAccountState: (_owner, state) => (published = state)
  })
  const handler = handlers.get('hantong:accounts-notifications-enabled')
  const event = invokeEvent(owner)
  assert.throws(() => handler(event, accountId), /Request rejected/)
  assert.throws(() => handler(event, accountId, 'false'), /Request rejected/)
  assert.throws(() => handler(event, accountId, false, 'extra'), /Request rejected/)
  assert.equal(persisted, false)
  const state = handler(event, accountId, false)
  assert.equal(persisted, true)
  assert.deepEqual(published, state)
})

test('Google status completion is rejected after its owning window changes', async () => {
  const pending = deferred()
  const firstWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  const secondWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  let currentWindow = firstWindow
  let calls = 0
  fixture({
    window: () => currentWindow,
    requireGoogleRuntime: () => ({
      getStatus: () => {
        calls += 1
        return pending.promise
      }
    })
  })
  const event = invokeEvent(firstWindow)
  const operation = handlers.get('hantong:google-connection-status')(event, accountId)
  assert.equal(calls, 1)
  currentWindow = secondWindow
  pending.resolve({ accountId, status: 'connected' })
  await assert.rejects(operation, /Request rejected/)
})

test('Google status completion returns when its original owner remains current', async () => {
  const pending = deferred()
  const owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  fixture({
    window: () => owner,
    requireGoogleRuntime: () => ({ getStatus: () => pending.promise })
  })
  const operation = handlers.get('hantong:google-connection-status')(invokeEvent(owner), accountId)
  const status = { accountId, status: 'connected' }
  pending.resolve(status)
  assert.deepEqual(await operation, status)
})
