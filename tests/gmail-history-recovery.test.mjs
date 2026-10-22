/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const sourceUrl = new URL('../src/main/gmail-history-sync.ts', import.meta.url)
const { createGmailSyncStore } = loadTypeScript(
  new URL('../src/main/gmail-sync-store.ts', import.meta.url)
)
const { GmailMetadataFailure } = loadTypeScript(
  new URL('../src/main/gmail-metadata.ts', import.meta.url)
)

function harness({
  cursors = {},
  pages = [],
  profile = '10',
  exists = () => true,
  storeFailure = false
} = {}) {
  const saved = new Map(Object.entries(cursors))
  const calls = []
  const readers = [...pages]
  const store = {
    read: (id) => saved.get(id) ?? null,
    write(id, value) {
      calls.push(['write', id, value])
      if (storeFailure) throw new Error('private disk detail')
      saved.set(id, value)
    },
    delete: (id) => saved.delete(id)
  }
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store,
    accountExists: exists,
    readHistoryId: async (id, signal) => {
      calls.push(['profile', id, signal.aborted])
      return profile
    },
    readHistoryPage: async (id, start, token, signal) => {
      calls.push(['page', id, start, token, signal.aborted])
      const next = readers.shift()
      if (next && typeof next === 'object' && 'message' in next) throw next
      return next
    }
  })
  return { sync, saved, calls }
}

test('reopening the durable store suppresses IDs replayed at the saved cursor', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-history-restart-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = createGmailSyncStore(directory)
  store.write(firstId, '10')
  const first = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store,
    accountExists: () => true,
    readHistoryId: async () => '11',
    readHistoryPage: async () => ({ historyId: '11', addedMessageIds: ['not-handed-off'] })
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await first.sync(firstId))), {
    kind: 'changes',
    historyId: '11',
    addedMessageIds: ['not-handed-off']
  })
  const reopened = createGmailSyncStore(directory)
  const second = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: reopened,
    accountExists: () => true,
    readHistoryId: async () => '12',
    readHistoryPage: async () => ({ historyId: '11', addedMessageIds: ['not-handed-off'] })
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await second.sync(firstId))), {
    kind: 'changes',
    historyId: '11',
    addedMessageIds: []
  })
})

test('accounts reconcile independently while one account is pending', async () => {
  let releaseFirst
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve
  })
  const stores = new Map([
    [firstId, '5'],
    [secondId, '7']
  ])
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: {
      read: (id) => stores.get(id) ?? null,
      write: (id, value) => stores.set(id, value),
      delete: (id) => stores.delete(id)
    },
    accountExists: () => true,
    readHistoryId: async () => '20',
    readHistoryPage: async (id) => {
      if (id === firstId) await firstGate
      return { historyId: id === firstId ? '6' : '8', addedMessageIds: [id] }
    }
  })
  const pending = sync.sync(firstId)
  assert.deepEqual(JSON.parse(JSON.stringify(await sync.sync(secondId))), {
    kind: 'changes',
    historyId: '8',
    addedMessageIds: [secondId]
  })
  releaseFirst()
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    kind: 'changes',
    historyId: '6',
    addedMessageIds: [firstId]
  })
})

test('cancel fences an abort-ignoring reader and stale finally leaves a newer flight intact', async () => {
  const releases = []
  const starts = []
  const stores = new Map([[firstId, '5']])
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: {
      read: (id) => stores.get(id) ?? null,
      write: (id, value) => stores.set(id, value),
      delete: (id) => stores.delete(id)
    },
    accountExists: () => true,
    readHistoryId: async () => '20',
    readHistoryPage: async (id, start, token) => {
      starts.push(token ?? 'first')
      await new Promise((resolve) => releases.push(resolve))
      return {
        historyId: token === undefined ? '6' : '7',
        addedMessageIds: [token ?? 'old'],
        ...(token === undefined ? { nextPageToken: 'second' } : {})
      }
    }
  })
  const old = sync.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  sync.cancel(firstId)
  const newer = sync.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  releases[0]()
  await assert.rejects(old, (error) => error.code === 'cancelled')
  await new Promise((resolve) => setImmediate(resolve))
  const follower = sync.sync(firstId)
  assert.equal(stores.get(firstId), '5')
  releases[1]()
  await new Promise((resolve) => setImmediate(resolve))
  releases[2]()
  assert.equal(await follower, null)
  assert.deepEqual(JSON.parse(JSON.stringify(await newer)), {
    kind: 'changes',
    historyId: '7',
    addedMessageIds: ['old', 'second']
  })
  assert.deepEqual(starts, ['first', 'first', 'second'])
})

test('reset during a pending profile read deletes the cursor and blocks stale persistence', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const stores = new Map()
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: {
      read: (id) => stores.get(id) ?? null,
      write: (id, value) => stores.set(id, value),
      delete: (id) => stores.delete(id)
    },
    accountExists: () => true,
    readHistoryId: async () => {
      await gate
      return '20'
    },
    readHistoryPage: async () => ({ historyId: '21', addedMessageIds: [] })
  })
  const pending = sync.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  sync.reset(firstId)
  release()
  await assert.rejects(pending, (error) => error.code === 'cancelled')
  assert.equal(stores.has(firstId), false)
})

test('profile-reader failure is sanitized and does not establish a cursor', async () => {
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: { read: () => null, write: () => assert.fail('must not write'), delete: () => {} },
    accountExists: () => true,
    readHistoryId: async () => {
      throw new Error('private provider detail')
    },
    readHistoryPage: async () => assert.fail('must not read history')
  })
  await assert.rejects(
    sync.sync(firstId),
    (error) => error.code === 'unavailable' && !('cause' in error)
  )
})

test('concurrent followers receive the owner failure instead of a false success', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: { read: () => '5', write: () => {}, delete: () => {} },
    accountExists: () => true,
    readHistoryId: async () => '20',
    readHistoryPage: async () => {
      await gate
      throw new Error('private failure')
    }
  })
  const owner = sync.sync(firstId)
  const follower = sync.sync(firstId)
  release()
  await assert.rejects(owner, (error) => error.code === 'unavailable' && !('cause' in error))
  await assert.rejects(follower, (error) => error.code === 'unavailable' && !('cause' in error))
})

test('expired-history baseline failure stays sanitized and preserves the saved cursor', async () => {
  const stores = new Map([[firstId, '5']])
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: {
      read: (id) => stores.get(id) ?? null,
      write: (id, value) => stores.set(id, value),
      delete: (id) => stores.delete(id)
    },
    accountExists: () => true,
    readHistoryId: async () => {
      throw new Error('private profile failure')
    },
    readHistoryPage: async () => {
      throw new GmailMetadataFailure('history_expired')
    }
  })
  await assert.rejects(
    sync.sync(firstId),
    (error) => error.code === 'unavailable' && !('cause' in error)
  )
  assert.equal(stores.get(firstId), '5')
})

test('account removal during profile and page reads blocks cursor writes', async () => {
  let releaseProfile
  const profileGate = new Promise((resolve) => {
    releaseProfile = resolve
  })
  let exists = true
  const writes = []
  const baseline = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: { read: () => null, write: (...args) => writes.push(args), delete: () => {} },
    accountExists: () => exists,
    readHistoryId: async () => {
      await profileGate
      return '20'
    },
    readHistoryPage: async () => assert.fail('must not read history')
  })
  const pendingProfile = baseline.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  exists = false
  releaseProfile()
  await assert.rejects(pendingProfile, (error) => error.code === 'invalid_account')
  assert.deepEqual(writes, [])

  let releasePage
  const pageGate = new Promise((resolve) => {
    releasePage = resolve
  })
  exists = true
  const reconciliation = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: { read: () => '19', write: (...args) => writes.push(args), delete: () => {} },
    accountExists: () => exists,
    readHistoryId: async () => '20',
    readHistoryPage: async () => {
      await pageGate
      return { historyId: '20', addedMessageIds: ['candidate'] }
    }
  })
  const pendingPage = reconciliation.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  exists = false
  releasePage()
  await assert.rejects(pendingPage, (error) => error.code === 'invalid_account')
  assert.deepEqual(writes, [])
})

test('decimal cursor ordering accepts a value that crosses a digit-length boundary', async () => {
  const saved = '99999999999999999999'
  const next = '100000000000000000000'
  const h = harness({
    cursors: { [firstId]: saved },
    pages: [{ historyId: next, addedMessageIds: ['after-boundary'] }]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'changes',
    historyId: next,
    addedMessageIds: ['after-boundary']
  })
  assert.equal(h.saved.get(firstId), next)
})

test('cancelling an owner rejects concurrent followers with the same cancellation', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const sync = loadTypeScript(sourceUrl, {
    './gmail-metadata': { GmailMetadataFailure }
  }).createGmailHistorySync({
    store: {
      read: () => '5',
      write: () => assert.fail('cancelled operation must not write'),
      delete: () => {}
    },
    accountExists: () => true,
    readHistoryId: async () => '20',
    readHistoryPage: async () => {
      await gate
      return { historyId: '6', addedMessageIds: [] }
    }
  })
  const owner = sync.sync(firstId)
  const follower = sync.sync(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  sync.cancel(firstId)
  release()
  await assert.rejects(owner, (error) => error.code === 'cancelled')
  await assert.rejects(follower, (error) => error.code === 'cancelled')
})
