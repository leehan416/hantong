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

function setup(overrides = {}) {
  const alerts = []
  const badges = []
  const module = createGmailMailAlerts({
    accountExists: () => true,
    accountLabel: (id) => (id === first ? 'Gmail 1' : 'Gmail 2'),
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

test('the Dock badge sums inbox unread counts across accounts', async () => {
  const { module, badges } = setup()
  await module.onChanges(first, { kind: 'changes', historyId: '2', addedMessageIds: [] })
  await module.onChanges(second, { kind: 'changes', historyId: '2', addedMessageIds: [] })
  assert.deepEqual(badges, [3, 7])
  module.remove(second)
  assert.deepEqual(badges, [3, 7, 3])
})

test('new inbox mail notifies with account, sender and subject', async () => {
  const { module, alerts } = setup()
  await module.onChanges(first, { kind: 'changes', historyId: '2', addedMessageIds: ['m1'] })
  assert.deepEqual(alerts, [{ accountId: first, title: 'Gmail 1 · Ann', body: 'subject m1' }])
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

test('more than three arrivals collapse the rest into one summary alert', async () => {
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
  assert.deepEqual(alerts[3], { accountId: first, title: 'Gmail 1', body: '2 more new messages' })
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
