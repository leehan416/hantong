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
const first = { version: 1, accounts: [{ id: firstId }], activeAccountId: firstId }
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
