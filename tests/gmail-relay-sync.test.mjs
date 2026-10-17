/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailRelaySync } = loadTypeScript(
  new URL('../src/main/gmail-relay-sync.ts', import.meta.url)
)
const account = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const turn = () => new Promise((resolve) => setImmediate(resolve))
const changes = { kind: 'changes', historyId: '20', addedMessageIds: ['m1'] }

function deferredSync() {
  const calls = []
  return {
    calls,
    sync: () =>
      new Promise((resolve) => {
        calls.push(resolve)
      })
  }
}

function fakeWatch(nextDueAt = null) {
  const log = []
  return {
    log,
    connect: async (id, now) => log.push(['connect', id, now]),
    runDue: async (now) => log.push(['runDue', now]),
    disconnect: (id) => log.push(['disconnect', id]),
    dispose: () => log.push(['dispose']),
    getNextDueAt: () => nextDueAt,
    pause: () => undefined,
    resume: async () => []
  }
}

function base(overrides = {}) {
  return {
    sync: async () => changes,
    resetSync: () => undefined,
    now: () => 1000,
    onChanges: () => undefined,
    setTimeout: () => 'timer',
    clearTimeout: () => undefined,
    ...overrides
  }
}

test('ready signal registers the watch and syncs; mailbox hint only syncs', async () => {
  const watch = fakeWatch()
  const synced = []
  const relay = createGmailRelaySync(
    base({ watch, sync: async (id) => (synced.push(id), changes) })
  )
  relay.onSignal(account, { type: 'ready', resync: true })
  await turn()
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '20' })
  await turn()
  assert.deepEqual(watch.log, [['connect', account, 1000]])
  assert.deepEqual(synced, [account, account])
})

test('hints during an in-flight sync coalesce into exactly one follow-up pass', async () => {
  const deferred = deferredSync()
  const relay = createGmailRelaySync(base({ sync: deferred.sync }))
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '20' })
  await turn()
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '21' })
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '22' })
  assert.equal(deferred.calls.length, 1)
  deferred.calls[0](changes)
  await turn()
  await turn()
  assert.equal(deferred.calls.length, 2)
})

test('sync results reach onChanges; failures and null results do not', async () => {
  const seen = []
  const results = [changes, null]
  const relay = createGmailRelaySync(
    base({
      sync: async () => {
        if (!results.length) throw new Error('unavailable')
        return results.shift()
      },
      onChanges: (id, result) => seen.push([id, result])
    })
  )
  for (let i = 0; i < 3; i += 1) {
    relay.onSignal(account, { type: 'mailbox_changed', historyId: '20' })
    await turn()
    await turn()
  }
  assert.deepEqual(seen, [[account, changes]])
})

test('disconnect drops the watch, resets the cursor and discards a late sync result', async () => {
  const deferred = deferredSync()
  const watch = fakeWatch()
  const reset = []
  const seen = []
  const relay = createGmailRelaySync(
    base({
      watch,
      sync: deferred.sync,
      resetSync: (id) => reset.push(id),
      onChanges: (id) => seen.push(id)
    })
  )
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '20' })
  await turn()
  relay.disconnect(account)
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '21' })
  await turn()
  deferred.calls[0](changes)
  await turn()
  assert.deepEqual(reset, [account])
  assert.deepEqual(watch.log, [['disconnect', account]])
  assert.deepEqual(seen, [])
  // The stale pass must not clear the newer pass, so a further hint is queued, not started.
  relay.onSignal(account, { type: 'mailbox_changed', historyId: '22' })
  await turn()
  assert.equal(deferred.calls.length, 2)
})

test('watch timer arms at the next due time and runs due renewals', async () => {
  const scheduled = []
  const watch = fakeWatch(5000)
  const relay = createGmailRelaySync(
    base({
      watch,
      setTimeout: (callback, delay) => (scheduled.push({ callback, delay }), scheduled.length)
    })
  )
  relay.onSignal(account, { type: 'ready', resync: true })
  await turn()
  await turn()
  assert.equal(scheduled.at(-1).delay, 4000)
  scheduled.at(-1).callback()
  await turn()
  assert.deepEqual(watch.log.at(-1), ['runDue', 1000])
})

test('dispose stops watches and ignores later signals', async () => {
  const watch = fakeWatch()
  let syncs = 0
  const relay = createGmailRelaySync(base({ watch, sync: async () => ((syncs += 1), changes) }))
  relay.dispose()
  relay.onSignal(account, { type: 'ready', resync: true })
  await turn()
  assert.deepEqual(watch.log, [['dispose']])
  assert.equal(syncs, 0)
})
