/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createNotificationConnectionController, notificationRelayFailureCode } = loadTypeScript(
  new URL('../src/main/notification-connection-controller.ts', import.meta.url)
)

const accountId = '11111111-1111-4111-8111-111111111111'

function fixture(overrides = {}) {
  let now = 0
  let nextTimer = 1
  const timers = new Map()
  const states = []
  const alerts = []
  const syncCalls = []
  const accountIds = new Set([accountId])
  const controller = createNotificationConnectionController({
    accountExists: (id) => accountIds.has(id),
    googleStatus: async () => 'connected',
    syncNow: (id) => syncCalls.push(id),
    recover: async () => undefined,
    cancelRecovery: async () => undefined,
    canAlert: () => true,
    alert: (id, status) => alerts.push([id, status]),
    publish: (snapshot) => states.push(snapshot),
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = nextTimer++
      timers.set(id, { callback, dueAt: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    random: () => 0.5,
    ...overrides
  })
  const advance = async (duration) => {
    now += duration
    const due = [...timers.entries()].filter(([, timer]) => timer.dueAt <= now)
    for (const [id, timer] of due) {
      timers.delete(id)
      timer.callback()
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { controller, accountIds, alerts, states, syncCalls, timers, advance }
}

test('notification readiness waits for persistent relay, SSE, watch, history and unread success', () => {
  const { controller } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: true, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'read_success' })
  controller.event({ type: 'session', accountId, outcome: 'success' })
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  assert.equal(controller.snapshot()[accountId].status, 'connecting')
  controller.event({ type: 'watch', accountId, outcome: 'renewed' })
  assert.equal(controller.snapshot()[accountId].status, 'connected')
  controller.dispose()
})

test('missing credentials alert once per incident and a later success rearms alerting', () => {
  const { controller, alerts } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  assert.equal(controller.snapshot()[accountId].status, 'reconnect_required')
  assert.equal(alerts.length, 1)
  controller.event({ type: 'credential_write', accountId, outcome: 'success' })
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  assert.equal(controller.snapshot()[accountId].status, 'connected')
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  assert.equal(alerts.length, 2)
  controller.dispose()
})

test('credential storage failure is not classified as Google reauthentication', () => {
  const { controller } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'read_failure' })
  assert.equal(controller.snapshot()[accountId].status, 'storage_error')
  controller.dispose()
})

test('only an allowlisted authorization rejection makes relay recovery auth-required', () => {
  const { controller } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: true, accountIds: [accountId] })
  assert.equal(notificationRelayFailureCode('unauthorized'), 'unauthorized')
  assert.equal(notificationRelayFailureCode('some-secret-error'), 'unknown')
  controller.event({ type: 'session', accountId, outcome: 'blocked', code: 'invalid_response' })
  assert.equal(controller.snapshot()[accountId].status, 'unavailable')
  controller.event({ type: 'watch', accountId, outcome: 'blocked', code: 'forbidden' })
  assert.equal(controller.snapshot()[accountId].status, 'unavailable')
  controller.event({ type: 'watch', accountId, outcome: 'blocked', code: 'unauthorized' })
  assert.equal(controller.snapshot()[accountId].status, 'reconnect_required')
  controller.dispose()
})

test('recovery is coalesced and cancellation clears the pending browser state', async () => {
  let resolveRecovery
  let recoverCalls = 0
  const { controller } = fixture({
    recover: () => {
      recoverCalls++
      return new Promise((resolve) => {
        resolveRecovery = resolve
      })
    }
  })
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  const recovery = controller.recover(accountId)
  await controller.recover(accountId)
  assert.equal(recoverCalls, 1)
  assert.equal(controller.snapshot()[accountId].recovering, true)
  await controller.cancel(accountId)
  assert.equal(controller.snapshot()[accountId].recovering, false)
  resolveRecovery()
  await recovery
  assert.equal(controller.snapshot()[accountId].recovering, false)
  controller.dispose()
})

test('a cancelled stale recovery cannot clear the next recovery action', async () => {
  const recoveries = []
  const { controller } = fixture({
    recover: () => new Promise((resolve) => recoveries.push(resolve))
  })
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  const oldRecovery = controller.recover(accountId)
  await controller.cancel(accountId)
  const newRecovery = controller.recover(accountId)
  assert.equal(controller.snapshot()[accountId].recovering, true)
  recoveries[0]()
  await oldRecovery
  assert.equal(controller.snapshot()[accountId].recovering, true)
  recoveries[1]()
  await newRecovery
  assert.equal(controller.snapshot()[accountId].recovering, false)
  controller.dispose()
})

test('successful explicit Google recovery clears revoked access and restores readiness', async () => {
  const { controller, syncCalls, advance } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'google', accountId, outcome: 'disconnected' })
  assert.equal(controller.snapshot()[accountId].status, 'reconnect_required')
  await controller.recover(accountId)
  controller.event({ type: 'credentials', accountId, outcome: 'read_success' })
  controller.event({ type: 'credential_write', accountId, outcome: 'success' })
  controller.event({ type: 'session', accountId, outcome: 'success' })
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  assert.equal(controller.snapshot()[accountId].status, 'connected')
  controller.event({ type: 'transport', accountId, outcome: 'failure' })
  await advance(60_000)
  assert.deepEqual(syncCalls, [accountId])
  controller.dispose()
})

test('invalid relay configuration retains Google history fallback without OAuth or relay retry', async () => {
  let recoverCalls = 0
  let reconnectCalls = 0
  const { controller, syncCalls, advance } = fixture({
    recover: async () => {
      recoverCalls++
    },
    reconnectRelay: async () => {
      reconnectCalls++
    }
  })
  controller.configure({ relay: 'invalid', watchConfigured: false, accountIds: [accountId] })
  assert.equal(controller.snapshot()[accountId].status, 'unavailable')
  await controller.recover(accountId)
  await controller.retry(accountId)
  assert.equal(recoverCalls, 0)
  assert.equal(reconnectCalls, 0)
  assert.deepEqual(syncCalls, [accountId])
  await advance(60_000)
  assert.deepEqual(syncCalls, [accountId, accountId])
  assert.equal(controller.snapshot()[accountId].status, 'unavailable')
  controller.dispose()
})

test('alerts wait for a global pending OAuth/recovery gate and flush when it clears', () => {
  let oauthPending = true
  const { controller, alerts } = fixture({ canAlert: () => !oauthPending })
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  assert.equal(alerts.length, 0)
  oauthPending = false
  controller.flushAlerts()
  assert.equal(alerts.length, 1)
  controller.dispose()
})

test('degraded recovery fallback runs after sixty seconds and backs off on failure', async () => {
  const { controller, syncCalls, advance } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'read_success' })
  controller.event({ type: 'transport', accountId, outcome: 'failure', code: 'network_error' })
  await advance(59_999)
  assert.deepEqual(syncCalls, [])
  await advance(1)
  assert.deepEqual(syncCalls, [accountId])
  controller.event({ type: 'history', accountId, outcome: 'failure' })
  await advance(59_999)
  assert.deepEqual(syncCalls, [accountId])
  await advance(1)
  assert.deepEqual(syncCalls, [accountId, accountId])
  controller.dispose()
})

test('fallback success repeats every minute and repeated failures use escalating delays', async () => {
  const { controller, syncCalls, advance, timers } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  await advance(60_000)
  assert.deepEqual(syncCalls, [accountId])
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  await advance(59_999)
  assert.equal(syncCalls.length, 1)
  await advance(1)
  assert.equal(syncCalls.length, 2)
  controller.event({ type: 'history', accountId, outcome: 'failure' })
  assert.equal([...timers.values()][0].dueAt, 180_000)
  await advance(59_999)
  assert.equal(syncCalls.length, 2)
  await advance(1)
  assert.equal(syncCalls.length, 3)
  controller.event({ type: 'history', accountId, outcome: 'failure' })
  assert.equal([...timers.values()][0].dueAt, 300_000)
  controller.dispose()
})

test('connected status cancels fallback and sync failures do not hide auth recovery', async () => {
  const { controller, syncCalls, advance, timers } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  controller.event({ type: 'session', accountId, outcome: 'blocked' })
  controller.event({ type: 'history', accountId, outcome: 'failure' })
  assert.equal(controller.snapshot()[accountId].status, 'reconnect_required')

  controller.event({ type: 'credential_write', accountId, outcome: 'success' })
  controller.event({ type: 'session', accountId, outcome: 'success' })
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  assert.equal(controller.snapshot()[accountId].status, 'connected')
  assert.equal(timers.size, 0)
  await advance(60_000)
  assert.deepEqual(syncCalls, [])
  controller.dispose()
})

test('resume revalidates a previously connected relay and skips fallback for revoked Google access', async () => {
  let google = 'connected'
  let reopen = 0
  const { controller, syncCalls, advance } = fixture({
    googleStatus: async () => google,
    reconnectRelay: async () => {
      reopen++
    }
  })
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'read_success' })
  controller.event({ type: 'credential_write', accountId, outcome: 'success' })
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  controller.event({ type: 'history', accountId, outcome: 'success' })
  controller.event({ type: 'unread', accountId, outcome: 'success' })
  assert.equal(controller.snapshot()[accountId].status, 'connected')
  controller.suspend()
  controller.resume([accountId])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(reopen, 1)
  assert.equal(controller.snapshot()[accountId].status, 'retrying')
  google = 'reconnect_required'
  const resumeCatchupCount = syncCalls.length
  await advance(60_000)
  assert.equal(syncCalls.length, resumeCatchupCount)
  assert.equal(controller.snapshot()[accountId].status, 'reconnect_required')
  await advance(300_000)
  assert.equal(syncCalls.length, resumeCatchupCount)
  controller.dispose()
})

test('disconnect drops state and ignores late account work', () => {
  const { controller, accountIds } = fixture()
  controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
  controller.event({ type: 'credentials', accountId, outcome: 'missing' })
  accountIds.delete(accountId)
  controller.disconnect(accountId)
  controller.event({ type: 'transport', accountId, outcome: 'ready' })
  assert.deepEqual(Object.keys(controller.snapshot()), [])
  controller.dispose()
})

test('queued fallback status completion cannot sync after suspend, disconnect, or dispose', async () => {
  for (const lifecycle of ['suspend', 'disconnect', 'dispose']) {
    let resolveGoogleStatus
    const { controller, accountIds, syncCalls, advance } = fixture({
      googleStatus: () =>
        new Promise((resolve) => {
          resolveGoogleStatus = resolve
        })
    })
    controller.configure({ relay: 'enabled', watchConfigured: false, accountIds: [accountId] })
    await advance(60_000)

    if (lifecycle === 'suspend') controller.suspend()
    else if (lifecycle === 'disconnect') {
      accountIds.delete(accountId)
      controller.disconnect(accountId)
    } else controller.dispose()

    resolveGoogleStatus('connected')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(syncCalls, [], `${lifecycle} must invalidate queued fallback work`)
    controller.dispose()
  }
})
