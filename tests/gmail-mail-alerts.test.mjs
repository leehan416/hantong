/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailMailAlerts, senderName } = loadTypeScript(
  new URL('../src/main/gmail-mail-alerts.ts', import.meta.url)
)
const first = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const second = 'b1b2c3d4-e5f6-4789-8abc-123456789abc'
const unread = (from, subject) => ({ from, subject, unreadInInbox: true })
const notificationPause = () => ({ paused: false, notifyAfter: 0, revision: 0 })

function setup(overrides = {}) {
  const alerts = []
  const badges = []
  const module = createGmailMailAlerts({
    accountExists: () => true,
    notificationsEnabled: () => true,
    notificationPause,
    korean: () => true,
    readUnreadCount: async (id) => (id === first ? 3 : 4),
    readSummary: async (_id, messageId) => unread('Ann <ann@example.com>', `subject ${messageId}`),
    notify: (alert) => alerts.push({ ...alert }),
    setBadge: (total) => badges.push(total),
    ...overrides
  })
  return { module, alerts, badges }
}

test('sender name prefers the display name and falls back to the address', () => {
  assert.equal(senderName('"Ann Lee" <ann@example.com>'), 'Ann Lee')
  assert.equal(senderName('<ann@example.com>'), 'ann@example.com')
  assert.equal(senderName('ann@example.com'), 'ann@example.com')
})

test('a baseline refreshes the badge but never notifies', async () => {
  const { module, alerts, badges } = setup()
  await module.onChanges(first, { kind: 'baseline', historyId: '1', addedMessageIds: [] })
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [3])
})

test('disabled account still refreshes its badge and never reads or queues arrival summaries', async () => {
  let enabled = false
  let finishUnread
  let summaryCalls = 0
  const { module, alerts, badges } = setup({
    notificationsEnabled: () => enabled,
    readUnreadCount: () => new Promise((resolve) => (finishUnread = resolve)),
    readSummary: async () => {
      summaryCalls += 1
      throw new Error('disabled batches must not read summaries')
    }
  })
  const pending = module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4']
  })
  enabled = true
  finishUnread(3)
  await pending
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [3])
  assert.equal(summaryCalls, 0)
})

test('notification preference gates only its account while badge counts still sum across accounts', async () => {
  const { module, alerts, badges } = setup({
    notificationsEnabled: (id) => id !== first
  })
  for (const accountId of [first, second]) {
    await module.onChanges(accountId, {
      kind: 'changes',
      historyId: '2',
      addedMessageIds: ['m1']
    })
  }
  assert.deepEqual(alerts, [{ accountId: second, title: 'Ann', body: 'subject m1' }])
  assert.deepEqual(badges, [3, 7])
})

test('turning notifications off while summaries are pending suppresses detailed and summary alerts', async () => {
  let enabled = true
  const finish = []
  const { module, alerts, badges } = setup({
    notificationsEnabled: () => enabled,
    readSummary: () => new Promise((resolve) => finish.push(resolve))
  })
  const pending = module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4']
  })
  enabled = false
  for (const resolve of finish) resolve(unread('Ann <ann@example.com>', 'subject'))
  await pending
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [3])
})

test('global pause suppresses mail alerts while unread badges continue updating', async () => {
  const { module, alerts, badges } = setup({
    notificationPause: () => ({ paused: true, notifyAfter: 0, revision: 1 })
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4']
  })
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [3])
})

test('delayed backlog uses Gmail internal dates and only counts eligible unread messages in summary', async () => {
  const receivedAt = { m1: 99, m2: 100, m3: 101, m4: 102, m5: 103, m6: 104 }
  const { module, alerts } = setup({
    notificationPause: () => ({ paused: false, notifyAfter: 100, revision: 2 }),
    readSummary: async (_id, messageId) => ({
      from: `Sender ${messageId} <${messageId}@example.com>`,
      subject: `subject ${messageId}`,
      unreadInInbox: true,
      receivedAt: receivedAt[messageId]
    })
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']
  })
  assert.deepEqual(alerts, [
    { accountId: first, title: 'Sender m2', body: 'subject m2' },
    { accountId: first, title: 'Sender m3', body: 'subject m3' },
    { accountId: first, title: 'Sender m4', body: 'subject m4' },
    { accountId: first, title: '새 메일', body: '새 메일 2통이 더 있습니다' }
  ])
})

test('backlog summary excludes old, unread-false, failed, and malformed timestamps', async () => {
  const { module, alerts } = setup({
    notificationPause: () => ({ paused: false, notifyAfter: 100, revision: 2 }),
    readSummary: async (_id, messageId) => {
      if (messageId === 'failed') throw new Error('offline')
      return {
        from: `Sender <${messageId}@example.com>`,
        subject: messageId,
        unreadInInbox: messageId !== 'read',
        receivedAt: messageId === 'invalid' ? NaN : messageId === 'missing' ? undefined : 99
      }
    }
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['old', 'read', 'failed', 'invalid', 'missing']
  })
  assert.deepEqual(alerts, [])
})

test('pause followed by resume invalidates pending notifications without affecting badge refresh', async () => {
  let policy = { paused: false, notifyAfter: 0, revision: 0 }
  const finish = []
  const { module, alerts, badges } = setup({
    notificationPause: () => policy,
    readSummary: () => new Promise((resolve) => finish.push(resolve))
  })
  const pending = module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2']
  })
  policy = { paused: true, notifyAfter: 50, revision: 1 }
  policy = { paused: false, notifyAfter: 50, revision: 2 }
  for (const resolve of finish) {
    resolve({ ...unread('Ann <ann@example.com>', 'subject'), receivedAt: 60 })
  }
  await pending
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [3])
})

test('delayed backlog reads use bounded concurrency', async () => {
  let active = 0
  let maximum = 0
  const { module, alerts } = setup({
    notificationPause: () => ({ paused: false, notifyAfter: 1, revision: 1 }),
    readSummary: async (_id, messageId) => {
      active += 1
      maximum = Math.max(maximum, active)
      await Promise.resolve()
      active -= 1
      return { ...unread('Ann <ann@example.com>', messageId), receivedAt: 1 }
    }
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: Array.from({ length: 10 }, (_, index) => `m${index}`)
  })
  assert.equal(maximum <= 4, true)
  assert.equal(alerts.length, 4)
})

test('the Dock badge sums inbox unread counts across accounts', async () => {
  const { module, badges } = setup()
  await module.onChanges(first, { kind: 'changes', historyId: '2', addedMessageIds: [] })
  await module.onChanges(second, { kind: 'changes', historyId: '2', addedMessageIds: [] })
  assert.deepEqual(badges, [3, 7])
  module.remove(second)
  assert.deepEqual(badges, [3, 7, 3])
})

test('new inbox mail notifies with sender as title and subject as body', async () => {
  const { module, alerts } = setup()
  await module.onChanges(first, { kind: 'changes', historyId: '2', addedMessageIds: ['m1'] })
  assert.deepEqual(alerts, [{ accountId: first, title: 'Ann', body: 'subject m1' }])
})

test('mail already read or archived and failed lookups stay silent', async () => {
  const { module, alerts } = setup({
    readSummary: async (_id, messageId) => {
      if (messageId === 'gone') throw new Error('not found')
      return { from: 'Ann <a@x>', subject: 's', unreadInInbox: false }
    }
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['read', 'gone']
  })
  assert.deepEqual(alerts, [])
})

test('more than three arrivals collapse the rest into a generic summary alert', async () => {
  const looked = []
  const { module, alerts } = setup({
    readSummary: async (_id, messageId) => (looked.push(messageId), unread('Ann <a@x>', '')),
    korean: () => false
  })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4', 'm5']
  })
  assert.deepEqual(looked, ['m1', 'm2', 'm3'])
  assert.equal(alerts.length, 4)
  assert.equal(alerts[0].body, '(no subject)')
  assert.deepEqual(alerts[3], { accountId: first, title: 'New mail', body: '2 more new messages' })
})

test('collapsed alert title is localized', async () => {
  const { module, alerts } = setup({ korean: () => true })
  await module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1', 'm2', 'm3', 'm4']
  })
  assert.deepEqual(alerts[3], {
    accountId: first,
    title: '새 메일',
    body: '새 메일 1통이 더 있습니다'
  })
})

test('results that finish after the account is removed are dropped', async () => {
  let finish
  const { module, alerts, badges } = setup({
    readUnreadCount: () => new Promise((resolve) => (finish = resolve))
  })
  const pending = module.onChanges(first, {
    kind: 'changes',
    historyId: '2',
    addedMessageIds: ['m1']
  })
  module.remove(first)
  finish(9)
  await pending
  assert.deepEqual(alerts, [])
  assert.deepEqual(badges, [])
})

test('unread diagnostics separate fetch failure from stale and applied results', async () => {
  const outcomes = []
  let exists = true
  const { module } = setup({
    accountExists: () => exists,
    readUnreadCount: async () => 3,
    onDiagnostic: (event) => outcomes.push(event.type)
  })
  await module.onChanges(first, { kind: 'baseline', historyId: '1', addedMessageIds: [] })
  const pending = module.onChanges(first, { kind: 'baseline', historyId: '2', addedMessageIds: [] })
  // Account removal changes the generation before the pending unread result can be applied.
  module.remove(first)
  await pending
  assert.deepEqual(outcomes, ['unread.success', 'unread.applied', 'unread.success', 'unread.stale'])
})
