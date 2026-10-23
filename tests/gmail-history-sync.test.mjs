/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const sourceUrl = new URL('../src/main/gmail-history-sync.ts', import.meta.url)
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

test('first sync stores the profile cursor silently without reading history', async () => {
  const h = harness({ profile: '90071992547409931234567890' })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'baseline',
    historyId: '90071992547409931234567890',
    addedMessageIds: []
  })
  assert.deepEqual(
    h.calls.map(([kind]) => kind),
    ['profile', 'write']
  )
})

test('multi-page sync fixes the saved start cursor and emits unique candidates in order', async () => {
  const h = harness({
    cursors: { [firstId]: '8' },
    pages: [
      { historyId: '9', addedMessageIds: ['a', 'b', 'a'], nextPageToken: 'p1' },
      { historyId: '10', addedMessageIds: ['b', 'c'] }
    ]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'changes',
    historyId: '10',
    addedMessageIds: ['a', 'b', 'c']
  })
  assert.deepEqual(
    h.calls.filter(([kind]) => kind === 'page').map(([, , start, token]) => [start, token]),
    [
      ['8', undefined],
      ['8', 'p1']
    ]
  )
  assert.equal(h.saved.get(firstId), '10')
})

test('a later page failure emits no candidates, commits nothing, and retry starts at the old cursor', async () => {
  const h = harness({
    cursors: { [firstId]: '8' },
    pages: [
      { historyId: '9', addedMessageIds: ['partial'], nextPageToken: 'p1' },
      new Error('provider detail'),
      { historyId: '10', addedMessageIds: ['complete'] }
    ]
  })
  await assert.rejects(
    h.sync.sync(firstId),
    (error) => error.code === 'unavailable' && !('cause' in error)
  )
  assert.equal(h.saved.get(firstId), '8')
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'changes',
    historyId: '10',
    addedMessageIds: ['complete']
  })
  assert.deepEqual(
    h.calls.filter(([kind]) => kind === 'page').map(([, , start]) => start),
    ['8', '8', '8']
  )
})

test('expired history after partial results silently establishes a fresh baseline', async () => {
  const h = harness({
    cursors: { [firstId]: '8' },
    profile: '20',
    pages: [
      { historyId: '9', addedMessageIds: ['partial'], nextPageToken: 'p1' },
      new GmailMetadataFailure('history_expired')
    ]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'baseline',
    historyId: '20',
    addedMessageIds: []
  })
  assert.equal(h.saved.get(firstId), '20')
})

test('replayed IDs are ignored when the final cursor is unchanged', async () => {
  const h = harness({
    cursors: { [firstId]: '10' },
    pages: [{ historyId: '10', addedMessageIds: ['old'] }]
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await h.sync.sync(firstId))), {
    kind: 'changes',
    historyId: '10',
    addedMessageIds: []
  })
  assert.equal(
    h.calls.some(([kind]) => kind === 'write'),
    false
  )
})

test('cursor regression, invalid IDs, repeated page tokens, and page bound fail closed', async () => {
  for (const pages of [
    [{ historyId: '9', addedMessageIds: ['x'] }],
    [
      { historyId: '11', addedMessageIds: [], nextPageToken: 'next' },
      { historyId: '10', addedMessageIds: [] }
    ],
    [{ historyId: '11', addedMessageIds: ['bad\nid'] }],
    [
      { historyId: '11', addedMessageIds: ['x'], nextPageToken: 'p' },
      { historyId: '12', addedMessageIds: [], nextPageToken: 'p' }
    ],
    Array.from({ length: 101 }, (_, index) => ({
      historyId: '11',
      addedMessageIds: [],
      nextPageToken: `p${index}`
    }))
  ]) {
    const h = harness({ cursors: { [firstId]: '10' }, pages })
    await assert.rejects(h.sync.sync(firstId), (error) => error.code === 'invalid_history')
    assert.equal(h.saved.get(firstId), '10')
  }
})

test('concurrent callers share one read and only the owner receives candidates', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const source = loadTypeScript(sourceUrl, { './gmail-metadata': { GmailMetadataFailure } })
  let calls = 0
  const concurrent = source.createGmailHistorySync({
    store: { read: () => '8', write: () => {}, delete: () => {} },
    accountExists: () => true,
    readHistoryId: async () => '10',
    readHistoryPage: async () => {
      calls += 1
      await gate
      return { historyId: '9', addedMessageIds: ['x'] }
    }
  })
  const owner = concurrent.sync(firstId)
  const follower = concurrent.sync(firstId)
  release()
  assert.deepEqual(JSON.parse(JSON.stringify(await owner)), {
    kind: 'changes',
    historyId: '9',
    addedMessageIds: ['x']
  })
  assert.equal(await follower, null)
  assert.equal(calls, 1)
})

test('unknown accounts reject before readers; valid account removal can reset a cursor', async () => {
  const h = harness({ cursors: { [firstId]: '4' }, exists: () => false })
  await assert.rejects(h.sync.sync(firstId), (error) => error.code === 'invalid_account')
  h.sync.reset(firstId)
  assert.equal(h.saved.has(firstId), false)
})

test('store failure suppresses candidates with sanitized unavailable failure', async () => {
  const h = harness({
    cursors: { [firstId]: '8' },
    pages: [{ historyId: '9', addedMessageIds: ['x'] }],
    storeFailure: true
  })
  await assert.rejects(
    h.sync.sync(firstId),
    (error) => error.code === 'unavailable' && !('cause' in error)
  )
})

test('invalid account IDs reject in sync, cancel, and reset', async () => {
  const h = harness()
  await assert.rejects(h.sync.sync('../bad'), (error) => error.code === 'invalid_account')
  assert.throws(
    () => h.sync.cancel('../bad'),
    (error) => error.code === 'invalid_account'
  )
  assert.throws(
    () => h.sync.reset('../bad'),
    (error) => error.code === 'invalid_account'
  )
})
