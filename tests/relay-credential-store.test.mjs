/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createRelayCredentialStore } = loadTypeScript(
  new URL('../src/main/relay-credential-store.ts', import.meta.url)
)
const account = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const other = 'b1b2c3d4-e5f6-4789-8abc-123456789abc'
// Reversible stand-in for safeStorage; proves the plaintext never reaches disk as-is.
const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (text) => Buffer.from(`enc:${text}`),
  decryptStringAsync: async (bytes) => ({
    result: bytes.toString().replace(/^enc:/, ''),
    shouldReEncrypt: false
  })
}

test('relay refresh tokens round-trip encrypted per account and delete idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-relay-'))
  try {
    const store = createRelayCredentialStore({ directory, platform: 'darwin', safeStorage })
    assert.equal(await store.read(account), null)
    await store.write(account, 'refresh_token-1')
    const raw = await readFile(join(directory, `${account}.credential`), 'utf8')
    assert.equal(raw.includes('refresh_token-1'), false)
    assert.equal(await store.read(account), 'refresh_token-1')
    assert.equal(await store.read(other), null)
    await store.delete(account)
    await store.delete(account)
    assert.equal(await store.read(account), null)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('relay credential store fails closed off macOS, on bad ids and on unsafe tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-relay-'))
  try {
    const linux = createRelayCredentialStore({ directory, platform: 'linux', safeStorage })
    await assert.rejects(linux.write(account, 'token'))
    const store = createRelayCredentialStore({ directory, platform: 'darwin', safeStorage })
    await assert.rejects(store.write('../escape', 'token'))
    await assert.rejects(store.write(account, 'bad token\n'))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
