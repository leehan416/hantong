/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test helpers use inferred JavaScript return types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { NotificationRecoveryController } = loadTypeScript(
  new URL('../src/renderer/src/notification-recovery-controller.ts', import.meta.url)
)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function state(accountId, status, recovering = false) {
  return { accountId, status, recovering }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('subscribes before snapshot and ignores an older snapshot that resolves after an event', async () => {
  const snapshot = deferred()
  let listener
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: () => snapshot.promise,
      onNotificationConnections: (next) => {
        listener = next
        return () => {}
      },
      recoverNotifications: async () => {},
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  listener({ first: state('first', 'connected') })
  snapshot.resolve({ first: state('first', 'retrying') })
  await tick()

  assert.equal(states.at(-1).notification.status, 'connected')
  controller.dispose()
})

test('duplicate recovery actions are coalesced per account', async () => {
  const recovery = deferred()
  let calls = 0
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'reconnect_required') }),
      onNotificationConnections: () => () => {},
      recoverNotifications: () => {
        calls += 1
        return recovery.promise
      },
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  const first = controller.recover()
  const duplicate = controller.recover()
  assert.equal(calls, 1)
  assert.equal(states.at(-1).operation, 'recovering')
  recovery.resolve()
  await Promise.all([first, duplicate])
  assert.equal(states.at(-1).operation, null)
  controller.dispose()
})

test('cancel supersedes pending recovery and ignores its late completion', async () => {
  const recovery = deferred()
  const cancellation = deferred()
  let cancelCalls = 0
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'reconnect_required') }),
      onNotificationConnections: () => () => {},
      recoverNotifications: () => recovery.promise,
      cancelNotificationRecovery: () => {
        cancelCalls += 1
        return cancellation.promise
      },
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  const recoveryAction = controller.recover()
  const cancelAction = controller.cancel()

  assert.equal(cancelCalls, 1)
  assert.equal(states.at(-1).operation, 'cancelling')

  recovery.resolve()
  await recoveryAction
  assert.equal(states.at(-1).operation, 'cancelling')

  cancellation.resolve()
  await cancelAction
  assert.equal(states.at(-1).operation, null)
  controller.dispose()
})

test('failed recovery clears pending state and preserves an actionable recovery status', async () => {
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'reconnect_required') }),
      onNotificationConnections: () => () => {},
      recoverNotifications: async () => {
        throw new Error('operation failed')
      },
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  await controller.recover()

  assert.equal(states.at(-1).notification.status, 'reconnect_required')
  assert.equal(states.at(-1).operation, null)
  assert.equal(states.at(-1).operationFailed, true)
  controller.dispose()
})

test('an authoritative connected event clears a prior action failure', async () => {
  let publish
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'unavailable') }),
      onNotificationConnections: (listener) => {
        publish = listener
        return () => {}
      },
      recoverNotifications: async () => {},
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {
        throw new Error('temporary failure')
      }
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  await controller.retry()
  assert.equal(states.at(-1).operationFailed, true)

  publish({ first: state('first', 'connected') })
  assert.equal(states.at(-1).operationFailed, false)
  assert.equal(states.at(-1).notification.status, 'connected')
  controller.dispose()
})

test('an authoritative disabled event clears a prior action failure', async () => {
  let publish
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'unavailable') }),
      onNotificationConnections: (listener) => {
        publish = listener
        return () => {}
      },
      recoverNotifications: async () => {},
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {
        throw new Error('temporary failure')
      }
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  await controller.retry()
  assert.equal(states.at(-1).operationFailed, true)

  publish({ first: state('first', 'disabled') })
  assert.equal(states.at(-1).operationFailed, false)
  assert.equal(states.at(-1).notification.status, 'disabled')
  controller.dispose()
})

test('late action completion after switching accounts does not publish stale local state', async () => {
  const recovery = deferred()
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({
        first: state('first', 'reconnect_required'),
        second: state('second', 'connected')
      }),
      onNotificationConnections: () => () => {},
      recoverNotifications: () => recovery.promise,
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  const pending = controller.recover()
  controller.selectAccount('second')
  const publishedBeforeCompletion = states.length
  recovery.resolve()
  await pending

  assert.equal(states.length, publishedBeforeCompletion)
  assert.equal(states.at(-1).accountId, 'second')
  controller.dispose()
})

test('removed account status and late action completion are ignored', async () => {
  const recovery = deferred()
  const states = []
  const controller = new NotificationRecoveryController(
    {
      getNotificationConnections: async () => ({ first: state('first', 'reconnect_required') }),
      onNotificationConnections: () => () => {},
      recoverNotifications: () => recovery.promise,
      cancelNotificationRecovery: async () => {},
      retryNotifications: async () => {}
    },
    (next) => states.push(next)
  )

  controller.selectAccount('first')
  await tick()
  const pending = controller.recover()
  controller.removeAccount('first')
  const publishedAfterRemoval = states.length
  recovery.resolve()
  await pending

  assert.equal(states.length, publishedAfterRemoval)
  assert.equal(states.at(-1).notification, null)
  controller.dispose()
})
