/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const storeModule = loadTypeScript(
  new URL('../src/main/google-credential-store.ts', import.meta.url)
)
const managerModule = loadTypeScript(
  new URL('../src/main/google-connection-manager.ts', import.meta.url)
)
const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const otherAccountId = 'b1b2c3d4-e5f6-4789-8abc-123456789abc'
const now = 1_800_000_000_000

function fakeStorage() {
  return {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value).map((byte) => byte ^ 0x5a),
    decryptStringAsync: async (bytes) => ({
      shouldReEncrypt: false,
      result: Buffer.from(bytes.map((byte) => byte ^ 0x5a)).toString()
    })
  }
}

async function fixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-credentials-'))
  const storage = fakeStorage()
  const store = storeModule.createGoogleCredentialStore({
    directory,
    platform: 'darwin',
    safeStorage: storage,
    ...overrides.store
  })
  const calls = { refresh: 0 }
  const manager = managerModule.createGoogleConnectionManager({
    credentialStore: overrides.credentialStore ?? store,
    now: () => now,
    refreshTokens: async (_config, token, signal) => {
      assert.equal(signal.aborted, false)
      calls.refresh += 1
      return overrides.refreshTokens
        ? overrides.refreshTokens(token, signal)
        : {
            accessToken: `access-${calls.refresh}`,
            expiresAt: now + 3_600_000
          }
    }
  })
  return { directory, storage, store, manager, calls }
}

async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true })
}

test('credential file stores only encrypted account-bound refresh credential data', async () => {
  const f = await fixture()
  try {
    await f.store.write(accountId, {
      refreshToken: 'refresh-secret',
      emailAddress: 'a@example.com'
    })
    const names = await readdir(f.directory)
    assert.deepEqual(names, [`${accountId}.credential`])
    const bytes = await readFile(join(f.directory, names[0]))
    assert.equal((await stat(join(f.directory, names[0]))).mode & 0o777, 0o600)
    assert.equal(bytes.toString().includes('refresh-secret'), false)
    assert.equal(bytes.toString().includes('a@example.com'), false)
    assert.equal(
      JSON.stringify(await f.store.read(accountId)),
      JSON.stringify({ refreshToken: 'refresh-secret', emailAddress: 'a@example.com' })
    )
    await assert.rejects(f.store.read('../outside'), { code: 'unavailable' })
  } finally {
    await cleanup(f.directory)
  }
})

test('safeStorage key rotation atomically re-encrypts validated plaintext once per read', async () => {
  const f = await fixture()
  try {
    await f.store.write(accountId, {
      refreshToken: 'refresh-secret',
      emailAddress: 'a@example.com'
    })
    const baseStorage = fakeStorage()
    let encryptions = 0
    const rotating = storeModule.createGoogleCredentialStore({
      directory: f.directory,
      platform: 'darwin',
      safeStorage: {
        ...baseStorage,
        encryptStringAsync: async (value) => {
          encryptions += 1
          return baseStorage.encryptStringAsync(value)
        },
        decryptStringAsync: async (bytes) => ({
          ...(await baseStorage.decryptStringAsync(bytes)),
          shouldReEncrypt: true
        })
      }
    })
    await rotating.read(accountId)
    assert.equal(encryptions, 1)
    assert.equal((await f.store.read(accountId)).refreshToken, 'refresh-secret')
  } finally {
    await cleanup(f.directory)
  }
})

test('credential store fails closed on unsupported platform or unavailable encryption', async () => {
  const f = await fixture({ store: { platform: 'linux' } })
  try {
    await assert.rejects(f.store.write(accountId, { refreshToken: 'x', emailAddress: 'a@b.com' }), {
      code: 'unavailable'
    })
    const unavailable = storeModule.createGoogleCredentialStore({
      directory: f.directory,
      platform: 'darwin',
      safeStorage: { ...fakeStorage(), isAsyncEncryptionAvailable: async () => false }
    })
    await assert.rejects(unavailable.read(accountId), { code: 'unavailable' })
  } finally {
    await cleanup(f.directory)
  }
})

test('corrupt protected record is rejected and preserved for recovery', async () => {
  const f = await fixture()
  try {
    const path = join(f.directory, `${accountId}.credential`)
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, 'corrupt'))
    await assert.rejects(f.store.read(accountId), { code: 'unavailable' })
    await assert.rejects(
      f.store.write(accountId, { refreshToken: 'new-secret', emailAddress: 'a@example.com' }),
      { code: 'unavailable' }
    )
    assert.equal((await readFile(path)).toString(), 'corrupt')
  } finally {
    await cleanup(f.directory)
  }
})

test('an encrypted record copied to another account cannot pass account binding', async () => {
  const f = await fixture()
  try {
    await f.store.write(accountId, {
      refreshToken: 'refresh-secret',
      emailAddress: 'a@example.com'
    })
    const source = join(f.directory, `${accountId}.credential`)
    const swapped = join(f.directory, `${otherAccountId}.credential`)
    await copyFile(source, swapped)
    await assert.rejects(f.store.read(otherAccountId), { code: 'unavailable' })
    assert.equal((await readFile(swapped)).toString(), (await readFile(source)).toString())
  } finally {
    await cleanup(f.directory)
  }
})

test('ciphertext can be deleted while the platform keychain is unavailable', async () => {
  const f = await fixture()
  try {
    await f.store.write(accountId, { refreshToken: 'secret', emailAddress: 'a@example.com' })
    const unavailable = storeModule.createGoogleCredentialStore({
      directory: f.directory,
      platform: 'darwin',
      safeStorage: { ...fakeStorage(), isAsyncEncryptionAvailable: async () => false }
    })
    await unavailable.delete(accountId)
    assert.equal(await f.store.read(accountId), null)
  } finally {
    await cleanup(f.directory)
  }
})

test('filesystem write failure preserves the existing target and exposes no path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-credentials-'))
  try {
    const blocker = join(directory, 'blocked')
    await writeFile(blocker, 'keep-this-file')
    const store = storeModule.createGoogleCredentialStore({
      directory: blocker,
      platform: 'darwin',
      safeStorage: fakeStorage()
    })
    await assert.rejects(
      store.write(accountId, { refreshToken: 'secret', emailAddress: 'a@example.com' }),
      (error) => error.code === 'unavailable' && !error.message.includes(blocker)
    )
    assert.equal((await readFile(blocker)).toString(), 'keep-this-file')
  } finally {
    await cleanup(directory)
  }
})
