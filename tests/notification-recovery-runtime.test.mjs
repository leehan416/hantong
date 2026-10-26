/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createNotificationRecoveryRuntime } = loadTypeScript(
  new URL('../src/main/notification-recovery-runtime.ts', import.meta.url),
  { electron: { dialog: {} } }
)

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createRuntime(connect) {
  let flushes = 0
  const runtime = createNotificationRecoveryRuntime({
    window: () => null,
    views: () => ({
      getActiveAccountId: () => 'account',
      getDocumentState: () => ({ ready: true })
    }),
    accessController: () => ({ connect }),
    notificationController: () => ({ flushAlerts: () => (flushes += 1) }),
    accountRemoval: () => null,
    accountStore: () => ({ getState: () => ({ accounts: [{ id: 'account' }] }) }),
    isQuitting: () => false,
    locale: () => 'en',
    showAccount: () => {}
  })
  return { runtime, flushes: () => flushes }
}

test('cleared recovery completion cannot remove a newer pending request', async () => {
  const firstConnection = deferred()
  const secondConnection = deferred()
  const connections = [firstConnection, secondConnection]
  let calls = 0
  const { runtime } = createRuntime(() => {
    const connection = connections[calls++]
    return connection.promise
  })

  const oldPromise = runtime.request('account')
  assert.equal(runtime.request('account'), oldPromise)
  assert.equal(calls, 1)
  runtime.clearPending('account')
  await assert.rejects(oldPromise, /cancelled/)

  const currentPromise = runtime.request('account')
  assert.equal(calls, 2)
  firstConnection.resolve({ connectionStatus: 'connected' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.hasPending('account'), true)

  secondConnection.resolve({ connectionStatus: 'connected' })
  await currentPromise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.hasPending('account'), false)
})
