/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailMailAlerts } = loadTypeScript(
  new URL('../src/main/gmail/gmail-mail-alerts.ts', import.meta.url)
)
const { createMainMailDiagnostics } = loadTypeScript(
  new URL('../src/main/mail/main-mail-diagnostics.ts', import.meta.url)
)
const { createMainDiagnostics } = loadTypeScript(
  new URL('../src/main/diagnostics/main-diagnostics.ts', import.meta.url)
)
const { createNotificationConnectionController } = loadTypeScript(
  new URL('../src/main/notifications/notification-connection-controller.ts', import.meta.url)
)

const accountId = '11111111-1111-4111-8111-111111111111'

function integrated() {
  let now = 0
  let nextTimer = 0
  const timers = new Map()
  const controller = createNotificationConnectionController({
    accountExists: () => true,
    googleStatus: async () => 'connected',
    syncNow: () => {},
    recover: async () => {},
    cancelRecovery: async () => {},
    canAlert: () => false,
    alert: () => {},
    publish: () => {},
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, due: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    random: () => 0.5
  })
  controller.configure({ relay: 'enabled', watchConfigured: true, accountIds: [accountId] })
  const diagnostics = createMainDiagnostics({ now: () => now })
  const routing = createMainMailDiagnostics({
    diagnostics,
    notifications: () => controller
  })
  const reads = []
  const alerts = createGmailMailAlerts({
    accountExists: () => true,
    notificationsEnabled: () => true,
    notificationPause: () => ({ paused: false, notifyAfter: 0, revision: 0 }),
    korean: () => false,
    readUnreadCount: () => new Promise((resolve, reject) => reads.push({ resolve, reject })),
    readSummary: async () => ({ from: '', subject: '', unreadInInbox: true }),
    notify: () => {},
    setBadge: () => {},
    onDiagnostic: routing.onUnread
  })
  routing.onRelay({ type: 'bootstrap', accountId, stage: 'credentials', outcome: 'success' })
  routing.onRelay({ type: 'session', accountId, outcome: 'success' })
  routing.onRelay({ type: 'transport', accountId, transport: { type: 'ready' } })
  routing.onHistory({ type: 'sync.success', accountId, historyId: '1' })
  routing.onWatch({ accountId, status: 'renewed', expiresAt: 10_000 })
  return { alerts, controller, reads, timers }
}

test('stale unread success cannot restore readiness after the current request fails', async () => {
  const f = integrated()
  const initial = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '1',
    addedMessageIds: []
  })
  f.reads[0].resolve(1)
  await initial
  assert.equal(f.controller.snapshot()[accountId].status, 'connected')

  const stale = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '2',
    addedMessageIds: []
  })
  const current = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '3',
    addedMessageIds: []
  })
  f.reads[2].reject(new Error('offline'))
  await current
  assert.equal(f.controller.snapshot()[accountId].status, 'retrying')
  assert.equal(f.timers.size, 1)
  f.reads[1].resolve(2)
  await stale
  assert.equal(f.controller.snapshot()[accountId].status, 'retrying')
  assert.equal(f.timers.size, 1)
  f.controller.dispose()
})

test('stale unread failure cannot degrade readiness after the current request applies', async () => {
  const f = integrated()
  const initial = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '1',
    addedMessageIds: []
  })
  f.reads[0].resolve(1)
  await initial

  const stale = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '2',
    addedMessageIds: []
  })
  const current = f.alerts.onChanges(accountId, {
    kind: 'baseline',
    historyId: '3',
    addedMessageIds: []
  })
  f.reads[2].resolve(3)
  await current
  assert.equal(f.controller.snapshot()[accountId].status, 'connected')
  f.reads[1].reject(new Error('stale offline'))
  await stale
  assert.equal(f.controller.snapshot()[accountId].status, 'connected')
  f.controller.dispose()
})
