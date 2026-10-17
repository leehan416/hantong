/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const sourceUrl = new URL('../src/main/gmail-sync-store.ts', import.meta.url)

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-sync-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function create(directory, overrides = {}) {
  return loadTypeScript(sourceUrl, overrides).createGmailSyncStore(directory)
}

test('fresh store has no file; saved huge cursors reopen as strings and isolate accounts', (t) => {
  const directory = temporaryDirectory(t)
  const store = create(directory)
  assert.equal(store.read(firstId), null)
  assert.deepEqual(fs.readdirSync(directory), [])
  const huge = '90071992547409931234567890'
  store.write(firstId, huge)
  store.write(secondId, '9')
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'gmail-sync.json'), 'utf8')), {
    version: 1,
    cursors: [
      { accountId: firstId, historyId: huge },
      { accountId: secondId, historyId: '9' }
    ]
  })
  assert.equal(create(directory).read(firstId), huge)
  assert.equal(fs.statSync(join(directory, 'gmail-sync.json')).mode & 0o777, 0o600)
})

test('delete removes only the selected cursor and deleting an absent cursor is a no-op', (t) => {
  const directory = temporaryDirectory(t)
  const store = create(directory)
  store.write(firstId, '1')
  store.write(secondId, '2')
  store.delete(firstId)
  assert.equal(store.read(firstId), null)
  assert.equal(store.read(secondId), '2')
  const before = readFileSync(join(directory, 'gmail-sync.json'), 'utf8')
  store.delete(firstId)
  assert.equal(readFileSync(join(directory, 'gmail-sync.json'), 'utf8'), before)
})

test('malformed, future-version, duplicate, or invalid stored cursors fail without overwrite', (t) => {
  const directory = temporaryDirectory(t)
  for (const value of [
    '{invalid',
    JSON.stringify({ version: 2, cursors: [] }),
    JSON.stringify({
      version: 1,
      cursors: [
        { accountId: firstId, historyId: '1' },
        { accountId: firstId, historyId: '2' }
      ]
    }),
    JSON.stringify({ version: 1, cursors: [{ accountId: firstId, historyId: '01' }] }),
    JSON.stringify({ version: 1, cursors: [{ accountId: '../bad', historyId: '1' }] }),
    JSON.stringify({
      version: 1,
      cursors: [{ accountId: firstId, historyId: '1', email: 'secret' }]
    })
  ]) {
    writeFileSync(join(directory, 'gmail-sync.json'), value)
    assert.throws(() => create(directory), /Unable to load Gmail sync data/)
    assert.equal(readFileSync(join(directory, 'gmail-sync.json'), 'utf8'), value)
  }
})

test('failed replacement keeps memory and disk; only this operation temp is cleaned', (t) => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'gmail-sync.json')
  const original = JSON.stringify({ version: 1, cursors: [{ accountId: firstId, historyId: '1' }] })
  writeFileSync(path, original)
  const store = create(directory, {
    'node:fs': {
      ...fs,
      renameSync: () => {
        throw new Error('secret disk detail')
      }
    }
  })
  assert.throws(
    () => store.write(firstId, '2'),
    (error) => {
      assert.equal(error.message, 'Unable to save Gmail sync data')
      assert.equal('cause' in error, false)
      return true
    }
  )
  assert.equal(store.read(firstId), '1')
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(directory), ['gmail-sync.json'])
})

test('failed delete replacement retains the old cursor in memory and on disk', (t) => {
  const directory = temporaryDirectory(t)
  const path = join(directory, 'gmail-sync.json')
  const original = JSON.stringify({ version: 1, cursors: [{ accountId: firstId, historyId: '1' }] })
  writeFileSync(path, original)
  const store = create(directory, {
    'node:fs': {
      ...fs,
      renameSync: () => {
        throw new Error('disk detail')
      }
    }
  })
  assert.throws(() => store.delete(firstId), /Unable to save Gmail sync data/)
  assert.equal(store.read(firstId), '1')
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.deepEqual(fs.readdirSync(directory), ['gmail-sync.json'])
})

test('invalid account IDs and cursors reject before storage I/O', (t) => {
  const directory = temporaryDirectory(t)
  const store = create(directory)
  for (const id of ['', '../escape', '33333333-3333-1333-8333-333333333333']) {
    assert.throws(() => store.read(id), /Invalid Gmail sync data/)
    assert.throws(() => store.delete(id), /Invalid Gmail sync data/)
    assert.throws(() => store.write(id, '1'), /Invalid Gmail sync data/)
  }
  for (const cursor of ['', '0', '01', '-1', '1\n', 1]) {
    assert.throws(() => store.write(firstId, cursor), /Invalid Gmail sync data/)
  }
  assert.deepEqual(fs.readdirSync(directory), [])
})
