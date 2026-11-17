/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
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
const exchange = loadTypeScript(new URL('../src/main/google-token-exchange.ts', import.meta.url))
const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const otherAccountId = 'b1b2c3d4-e5f6-4789-8abc-123456789abc'
const config = { clientId: 'desktop-client.apps.googleusercontent.com' }
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

test('protected-store failure prevents a connection from being reported connected', async () => {
  const f = await fixture({
    store: {
      safeStorage: {
        ...fakeStorage(),
        encryptStringAsync: async () => {
          throw new Error('private keychain detail')
        }
      }
    }
  })
  try {
    await assert.rejects(
      f.manager.acceptConnection(accountId, {
        emailAddress: 'owner@example.com',
        tokens: {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: now + 600_000
        }
      }),
      (error) => error.code === 'unavailable' && !error.message.includes('private')
    )
    assert.equal(
      JSON.stringify(await f.manager.getStatus(accountId)),
      JSON.stringify({ status: 'disconnected' })
    )
    assert.deepEqual(await readdir(f.directory), [])
  } finally {
    await cleanup(f.directory)
  }
})

test('grant generation advances on accepted replacement and disconnect', async () => {
  const f = await fixture()
  try {
    assert.equal(f.manager.getGeneration(accountId), 0)
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: now + 3_600_000
      }
    })
    assert.equal(f.manager.getGeneration(accountId), 1)
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: {
        accessToken: 'replacement-access',
        refreshToken: 'replacement-refresh',
        expiresAt: now + 3_600_000
      }
    })
    assert.equal(f.manager.getGeneration(accountId), 2)
    await f.manager.disconnect(accountId)
    assert.equal(f.manager.getGeneration(accountId), 3)
  } finally {
    await cleanup(f.directory)
  }
})

test('verified connection persists before connected and refreshes expired access tokens once per account', async () => {
  const f = await fixture()
  try {
    const accepted = await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: {
        accessToken: 'initial-access',
        refreshToken: 'refresh-secret',
        expiresAt: now + 10_000
      }
    })
    assert.equal(accepted.status, 'connected')
    assert.deepEqual(await f.manager.getAccessToken(accountId, config), 'access-1')
    assert.deepEqual(await f.manager.getAccessToken(accountId, config), 'access-1')
    assert.equal(f.calls.refresh, 1)
    assert.equal((await f.store.read(accountId)).refreshToken, 'refresh-secret')
  } finally {
    await cleanup(f.directory)
  }
})

test('a new manager restores connected status from protected credentials without returning tokens', async () => {
  const f = await fixture()
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: {
        accessToken: 'memory-only-access',
        refreshToken: 'refresh-secret',
        expiresAt: now + 600_000
      }
    })
    const restored = managerModule.createGoogleConnectionManager({
      credentialStore: f.store,
      now: () => now,
      refreshTokens: async () => ({ accessToken: 'new-access', expiresAt: now + 600_000 })
    })
    assert.equal(
      JSON.stringify(await restored.getStatus(accountId)),
      JSON.stringify({
        status: 'connected',
        emailAddress: 'owner@example.com'
      })
    )
    assert.equal(
      (await readFile(join(f.directory, `${accountId}.credential`), 'utf8')).includes(
        'memory-only-access'
      ),
      false
    )
  } finally {
    await cleanup(f.directory)
  }
})

test('late status restoration cannot override a connection accepted during its disk read', async () => {
  let store
  let releaseRead
  let notifyRead
  let firstRead = true
  const readStarted = new Promise((resolve) => {
    notifyRead = resolve
  })
  const readGate = new Promise((resolve) => {
    releaseRead = resolve
  })
  const f = await fixture({
    credentialStore: {
      read: async (...args) => {
        if (firstRead) {
          firstRead = false
          notifyRead()
          await readGate
        }
        return store.read(...args)
      },
      write: (...args) => store.write(...args),
      delete: (...args) => store.delete(...args)
    }
  })
  store = f.store
  try {
    const staleStatus = f.manager.getStatus(accountId)
    await readStarted
    const accepted = f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: now + 600_000 }
    })
    releaseRead()
    await assert.rejects(staleStatus, { code: 'disconnected' })
    assert.equal((await accepted).status, 'connected')
    assert.equal(await f.manager.getAccessToken(accountId, config), 'new-access')
  } finally {
    releaseRead()
    await cleanup(f.directory)
  }
})

test('same-account refresh is single-flight and a rotated token is persisted before access is returned', async () => {
  let resolveRefresh
  const f = await fixture({
    refreshTokens: async () =>
      new Promise((resolve) => {
        resolveRefresh = resolve
      })
  })
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old', refreshToken: 'refresh-old', expiresAt: now }
    })
    const first = f.manager.getAccessToken(accountId, config)
    const second = f.manager.getAccessToken(accountId, config)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(f.calls.refresh, 1)
    resolveRefresh({ accessToken: 'fresh', refreshToken: 'refresh-new', expiresAt: now + 60_000 })
    assert.deepEqual(await Promise.all([first, second]), ['fresh', 'fresh'])
    assert.equal((await f.store.read(accountId)).refreshToken, 'refresh-new')
  } finally {
    await cleanup(f.directory)
  }
})

test('failed refresh rotation persistence does not return or cache the new access token', async () => {
  let writes = 0
  let store
  const f = await fixture({
    refreshTokens: async () => ({
      accessToken: 'uncommitted-access',
      refreshToken: 'new-refresh',
      expiresAt: now + 60_000
    }),
    credentialStore: {
      read: (...args) => store.read(...args),
      write: async (account, credential) => {
        writes += 1
        if (credential.refreshToken === 'new-refresh') throw new Error('private filesystem error')
        return store.write(account, credential)
      },
      delete: (...args) => store.delete(...args)
    }
  })
  store = f.store
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'expired-access', refreshToken: 'old-refresh', expiresAt: now }
    })
    await assert.rejects(f.manager.getAccessToken(accountId, config), { code: 'unavailable' })
    assert.equal(writes, 2)
    assert.equal((await f.store.read(accountId)).refreshToken, 'old-refresh')
  } finally {
    await cleanup(f.directory)
  }
})

test('an already expired refresh response is rejected before its rotated credential is saved', async () => {
  const f = await fixture({
    refreshTokens: async () => ({
      accessToken: 'expired-response',
      refreshToken: 'new-refresh',
      expiresAt: now
    })
  })
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: now }
    })
    await assert.rejects(f.manager.getAccessToken(accountId, config), { code: 'unavailable' })
    assert.equal((await f.store.read(accountId)).refreshToken, 'old-refresh')
  } finally {
    await cleanup(f.directory)
  }
})

test('invalid_grant requires reconnect and does not retry or erase the protected record', async () => {
  const f = await fixture({
    refreshTokens: async () => {
      throw new exchange.GoogleOAuthFailure('invalid_grant')
    }
  })
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old', refreshToken: 'refresh-secret', expiresAt: now }
    })
    const generationBeforeRefresh = f.manager.getGeneration(accountId)
    await assert.rejects(f.manager.getAccessToken(accountId, config), {
      code: 'reconnect_required'
    })
    assert.equal(f.manager.getGeneration(accountId), generationBeforeRefresh + 1)
    assert.equal(
      JSON.stringify(await f.manager.getStatus(accountId)),
      JSON.stringify({ status: 'reconnect_required', emailAddress: 'owner@example.com' })
    )
    await assert.rejects(f.manager.getAccessToken(accountId, config), {
      code: 'reconnect_required'
    })
    assert.equal(f.calls.refresh, 1)
    assert.equal((await f.store.read(accountId)).refreshToken, 'refresh-secret')
  } finally {
    await cleanup(f.directory)
  }
})

test('disconnect cancels and fences late refresh results, then deletes only that account', async () => {
  let resolveRefresh
  let signal
  const f = await fixture({
    refreshTokens: async (_token, receivedSignal) => {
      signal = receivedSignal
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    }
  })
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old', refreshToken: 'refresh-secret', expiresAt: now }
    })
    await f.store.write(otherAccountId, {
      refreshToken: 'other-secret',
      emailAddress: 'other@example.com'
    })
    const pending = f.manager.getAccessToken(accountId, config)
    await new Promise((resolve) => setImmediate(resolve))
    await f.manager.disconnect(accountId)
    assert.equal(signal.aborted, true)
    resolveRefresh({
      accessToken: 'late-access',
      refreshToken: 'late-refresh',
      expiresAt: now + 60_000
    })
    await assert.rejects(pending, { code: 'disconnected' })
    assert.equal(
      JSON.stringify(await f.manager.getStatus(accountId)),
      JSON.stringify({ status: 'disconnected' })
    )
    assert.equal(
      JSON.stringify(await f.store.read(otherAccountId)),
      JSON.stringify({ refreshToken: 'other-secret', emailAddress: 'other@example.com' })
    )
    assert.equal(await f.store.read(accountId), null)
  } finally {
    resolveRefresh?.({ accessToken: 'late-access', expiresAt: now + 60_000 })
    await cleanup(f.directory)
  }
})

test('failed disconnect blocks lazy credential restoration from the undeleted file', async () => {
  let store
  const f = await fixture({
    credentialStore: {
      read: (...args) => store.read(...args),
      write: (...args) => store.write(...args),
      delete: async () => {
        throw new Error('private filesystem error')
      }
    }
  })
  store = f.store
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'access', refreshToken: 'refresh-secret', expiresAt: now + 600_000 }
    })
    await assert.rejects(f.manager.disconnect(accountId), { code: 'unavailable' })
    await assert.rejects(f.manager.getAccessToken(accountId, config), { code: 'disconnected' })
    assert.equal(
      JSON.stringify(await f.manager.getStatus(accountId)),
      JSON.stringify({ status: 'disconnected' })
    )
    assert.equal((await f.store.read(accountId)).refreshToken, 'refresh-secret')
  } finally {
    await cleanup(f.directory)
  }
})

test('failed replacement cannot fall back to the old protected credential', async () => {
  let store
  const f = await fixture({
    credentialStore: {
      read: (...args) => store.read(...args),
      write: async (account, credential) => {
        if (credential.refreshToken === 'replacement') throw new Error('private storage error')
        return store.write(account, credential)
      },
      delete: (...args) => store.delete(...args)
    }
  })
  store = f.store
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: now + 600_000 }
    })
    await assert.rejects(
      f.manager.acceptConnection(accountId, {
        emailAddress: 'owner@example.com',
        tokens: {
          accessToken: 'replacement-access',
          refreshToken: 'replacement',
          expiresAt: now + 600_000
        }
      }),
      { code: 'unavailable' }
    )
    await assert.rejects(f.manager.getAccessToken(accountId, config), { code: 'disconnected' })
    assert.equal((await f.store.read(accountId)).refreshToken, 'old-refresh')
  } finally {
    await cleanup(f.directory)
  }
})

test('reconnect replaces a pending refresh and keeps its late result from replacing new credentials', async () => {
  let resolveRefresh
  let signal
  const f = await fixture({
    refreshTokens: async (_token, receivedSignal) => {
      signal = receivedSignal
      return new Promise((resolve) => {
        resolveRefresh = resolve
      })
    }
  })
  try {
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'old', refreshToken: 'old-refresh', expiresAt: now }
    })
    const pending = f.manager.getAccessToken(accountId, config)
    await new Promise((resolve) => setImmediate(resolve))
    await f.manager.acceptConnection(accountId, {
      emailAddress: 'owner@example.com',
      tokens: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: now + 600_000 }
    })
    assert.equal(signal.aborted, true)
    resolveRefresh({
      accessToken: 'late-access',
      refreshToken: 'late-refresh',
      expiresAt: now + 60_000
    })
    await assert.rejects(pending, { code: 'disconnected' })
    assert.equal(await f.manager.getAccessToken(accountId, config), 'new-access')
    assert.equal((await f.store.read(accountId)).refreshToken, 'new-refresh')
  } finally {
    resolveRefresh?.({ accessToken: 'late-access', expiresAt: now + 60_000 })
    await cleanup(f.directory)
  }
})

test('refresh token exchange sends fixed HTTPS refresh grant and distinguishes invalid_grant safely', async () => {
  let captured
  const result = await exchange.refreshGoogleAccessToken(config, 'refresh-secret', {
    fetch: async (url, init) => {
      captured = { url, init }
      return {
        ok: true,
        status: 200,
        redirected: false,
        json: async () => ({ access_token: 'access', token_type: 'Bearer', expires_in: 120 })
      }
    },
    signal: new AbortController().signal,
    now: () => now
  })
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token')
  assert.equal(new URLSearchParams(captured.init.body).get('grant_type'), 'refresh_token')
  assert.equal(new URLSearchParams(captured.init.body).get('refresh_token'), 'refresh-secret')
  assert.equal(result.expiresAt, now + 120_000)
  await assert.rejects(
    exchange.refreshGoogleAccessToken(config, 'refresh-secret', {
      fetch: async () => ({
        ok: false,
        status: 400,
        redirected: false,
        json: async () => ({ error: 'invalid_grant', error_description: 'private' })
      }),
      signal: new AbortController().signal,
      now: () => now
    }),
    (error) => error.code === 'invalid_grant' && !error.message.includes('private')
  )
})
