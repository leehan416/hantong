import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const empty = { version: 1, accounts: [], activeAccountId: null }
const first = {
  version: 1,
  accounts: [{ id: firstId }],
  activeAccountId: firstId
}
const sourceUrl = new URL('../src/main/account-store.ts', import.meta.url)

test('a fresh account store does not create files until a change is saved', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const store = createAccountStore(directory, () => firstId)
  assert.deepEqual(structuredClone(store.getState()), empty)
  assert.deepEqual(fs.readdirSync(directory), [])
})

test('adding and selecting accounts survives reopening the store', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const ids = [firstId, secondId]
  const store = createAccountStore(directory, () => ids.shift())
  assert.deepEqual(structuredClone(store.add()), first)
  assert.deepEqual(structuredClone(store.add()), {
    version: 1,
    accounts: [{ id: firstId }, { id: secondId }],
    activeAccountId: secondId
  })
  store.activate(firstId)
  const reopened = createAccountStore(directory, () => secondId)
  assert.deepEqual(structuredClone(reopened.getState()), {
    version: 1,
    accounts: [{ id: firstId }, { id: secondId }],
    activeAccountId: firstId
  })
  assert.equal(fs.statSync(join(directory, 'accounts.json')).mode & 0o777, 0o600)
})

test('callers cannot mutate the stored account state through a returned snapshot', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const store = createAccountStore(directory, () => firstId)
  const result = store.add()
  result.accounts[0].id = secondId
  result.accounts.length = 0
  result.activeAccountId = null
  assert.deepEqual(structuredClone(store.getState()), first)
})

test('duplicate IDs and unknown selections cannot change the persisted state', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const store = createAccountStore(directory, () => firstId)
  store.add()
  assert.throws(() => store.add(), /Invalid account data/)
  assert.throws(() => store.activate(secondId), /Invalid account data/)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'accounts.json'), 'utf8')), first)
})

test('invalid saved data is reported without overwriting the file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  for (const value of [
    '{invalid json',
    JSON.stringify({ ...first, version: 2 }),
    JSON.stringify({ ...first, activeAccountId: secondId }),
    JSON.stringify({ ...first, accounts: [{ id: '../other-session' }] }),
    JSON.stringify({ ...first, accounts: [{ id: firstId, email: 'not-an-email' }] }),
    JSON.stringify({ ...first, accounts: [{ id: firstId, displayName: '  ' }] }),
    JSON.stringify({ ...first, accounts: [{ id: firstId }, { id: firstId }] })
  ]) {
    writeFileSync(join(directory, 'accounts.json'), value)
    assert.throws(() => createAccountStore(directory), /Unable to load account data/)
    assert.equal(readFileSync(join(directory, 'accounts.json'), 'utf8'), value)
  }
})

test('a failed atomic replacement preserves both the saved and in-memory state', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(join(directory, 'accounts.json'), JSON.stringify(first))
  const { createAccountStore } = loadTypeScript(sourceUrl, {
    'node:fs': {
      ...fs,
      renameSync: () => {
        throw new Error('simulated disk failure')
      }
    }
  })
  const store = createAccountStore(directory, () => secondId)
  assert.throws(() => store.add(), /Unable to save account data/)
  assert.deepEqual(structuredClone(store.getState()), first)
  assert.deepEqual(JSON.parse(readFileSync(join(directory, 'accounts.json'), 'utf8')), first)
  assert.deepEqual(fs.readdirSync(directory), ['accounts.json'])
})

test('a successful atomic replacement does not attempt to remove the already renamed file', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl, {
    'node:fs': {
      ...fs,
      rmSync: () => {
        throw new Error('cleanup must not run after successful replacement')
      }
    }
  })
  const store = createAccountStore(directory, () => firstId)
  assert.deepEqual(structuredClone(store.add()), first)
  assert.deepEqual(structuredClone(store.getState()), first)
})

test('removing inactive, active and last accounts preserves a valid selected account', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const ids = [firstId, secondId, '33333333-3333-4333-8333-333333333333']
  const store = loadTypeScript(sourceUrl).createAccountStore(directory, () => ids.shift())
  store.add()
  store.add()
  store.add()
  store.activate(secondId)
  assert.deepEqual(structuredClone(store.remove(firstId)), {
    version: 1,
    accounts: [{ id: secondId }, { id: '33333333-3333-4333-8333-333333333333' }],
    activeAccountId: secondId
  })
  assert.deepEqual(structuredClone(store.remove(secondId)), {
    version: 1,
    accounts: [{ id: '33333333-3333-4333-8333-333333333333' }],
    activeAccountId: '33333333-3333-4333-8333-333333333333'
  })
  assert.deepEqual(structuredClone(store.remove('33333333-3333-4333-8333-333333333333')), empty)
})

test('removing an unknown account rejects without changing the saved state', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const store = loadTypeScript(sourceUrl).createAccountStore(directory, () => firstId)
  store.add()
  assert.throws(() => store.remove(secondId), /Invalid account data/)
  assert.deepEqual(structuredClone(store.getState()), first)
})

test('files saved with the retired default account field still load', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    join(directory, 'accounts.json'),
    JSON.stringify({
      version: 1,
      accounts: [{ id: firstId }, { id: secondId }],
      activeAccountId: secondId,
      defaultAccountId: secondId
    })
  )
  const { createAccountStore } = loadTypeScript(sourceUrl)
  assert.deepEqual(structuredClone(createAccountStore(directory).getState()), {
    version: 1,
    accounts: [{ id: firstId }, { id: secondId }],
    activeAccountId: secondId
  })
})

test('account metadata persists independently of active selection', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const ids = [firstId, secondId]
  const store = createAccountStore(directory, () => ids.shift())
  store.add()
  store.add()
  store.setDisplayName(firstId, '  Personal  ')
  store.recordVerifiedEmail(firstId, 'personal@example.com')
  store.activate(firstId)
  assert.deepEqual(structuredClone(store.getState()), {
    version: 1,
    accounts: [
      { id: firstId, displayName: 'Personal', email: 'personal@example.com' },
      { id: secondId }
    ],
    activeAccountId: firstId
  })
  assert.deepEqual(
    structuredClone(createAccountStore(directory).getState()),
    structuredClone(store.getState())
  )
})

test('invalid account metadata and unknown account updates do not persist', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const store = createAccountStore(directory, () => firstId)
  store.add()
  const saved = readFileSync(join(directory, 'accounts.json'), 'utf8')
  assert.throws(() => store.setDisplayName(firstId, '  '), /Invalid account data/)
  assert.throws(() => store.setDisplayName(firstId, 'x'.repeat(81)), /Invalid account data/)
  assert.throws(() => store.recordVerifiedEmail(firstId, 'not-an-email'), /Invalid account data/)
  assert.throws(
    () => store.recordVerifiedEmail(firstId, 'personal..name@example.com'),
    /Invalid account data/
  )
  assert.throws(() => store.setDisplayName(secondId, 'Other'), /Invalid account data/)
  assert.equal(readFileSync(join(directory, 'accounts.json'), 'utf8'), saved)
})

test('accounts can be reordered and adding past the limit is refused', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-accounts-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const { createAccountStore } = loadTypeScript(sourceUrl)
  const ids = Array.from(
    { length: 11 },
    (_, index) => `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`
  )
  const queue = [...ids]
  const store = createAccountStore(directory, () => queue.shift())
  for (let index = 0; index < 10; index += 1) store.add()
  assert.throws(() => store.add(), { message: 'Account limit reached' })
  assert.equal(store.getState().accounts.length, 10)
  const moved = structuredClone(store.move(ids[0], 2))
  assert.deepEqual(
    moved.accounts.slice(0, 3).map((account) => account.id),
    [ids[1], ids[2], ids[0]]
  )
  assert.equal(moved.activeAccountId, ids[9])
  assert.deepEqual(
    structuredClone(createAccountStore(directory).getState()).accounts.map((account) => account.id),
    moved.accounts.map((account) => account.id)
  )
  for (const toIndex of [-1, 10, 1.5]) {
    assert.throws(() => store.move(ids[0], toIndex), { message: 'Invalid account data' })
  }
})
