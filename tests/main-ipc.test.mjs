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
