/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const relayClientModule = loadTypeScript(new URL('../src/main/relay-client.ts', import.meta.url))
const runtimeModule = loadTypeScript(new URL('../src/main/relay-runtime.ts', import.meta.url), {
  './relay-client': relayClientModule
})
const account = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const turn = () => new Promise((resolve) => setImmediate(resolve))

test('late relay session completion after disconnect is revoked and never streamed', async () => {
  let finishSession
  const revoked = []
  let streams = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: () =>
        new Promise((resolve) => {
          finishSession = resolve
        }),
      deleteSession: async (token) => revoked.push(token),
      consumeEvents: async () => {
        streams += 1
      }
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined
  })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  runtime.disconnect(account)
  finishSession({ accessToken: 'opaque-session', expiresAt: 2000 })
  await turn()
  assert.deepEqual(revoked, ['opaque-session'])
  assert.equal(streams, 0)
})

test('relay runtime starts one stream and disconnect aborts ownership', async () => {
  let connected
  let streamCount = 0
  const signal = { type: 'ready', resync: true }
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'opaque-session', expiresAt: 60_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async (_token, onEvent, abortSignal) => {
        streamCount += 1
        connected = abortSignal
        onEvent(signal)
        return new Promise((resolve) =>
          abortSignal.addEventListener('abort', resolve, { once: true })
        )
      }
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: (_id, event) => assert.equal(event.type, 'ready')
  })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  assert.equal(streamCount, 1)
  runtime.disconnect(account)
  assert.equal(connected.aborted, true)
})

test('relay EOF retries with bounded backoff and stops after unauthorized response', async () => {
  const timers = []
  let now = 1000
  let attempts = 0
  const failures = ['network_error', 'unavailable', 'network_error', 'unauthorized']
  const deleted = []
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'opaque-session', expiresAt: 100_000 }),
      deleteSession: async (token) => deleted.push(token),
      consumeEvents: async () => {
        attempts += 1
        throw new relayClientModule.RelayFailure(failures[attempts - 1])
      }
    },
    accountExists: () => true,
    now: () => now,
    onSignal: () => undefined,
    setTimeout: (callback, delay) => {
      const item = { callback, delay }
      timers.push(item)
      return item
    },
    clearTimeout: () => undefined
  })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  assert.equal(attempts, 1)
  for (const [attempt, delay] of [
    [1, 1000],
    [2, 2000],
    [3, 4000]
  ]) {
    const retry = timers.find((item) => item.delay === delay)
    assert.ok(retry)
    retry.callback()
    await turn()
    await turn()
    assert.equal(attempts, attempt + 1)
  }
  assert.equal(
    timers.some((item) => item.delay === 8000),
    false
  )
  assert.deepEqual(deleted, ['opaque-session'])
  now = 2000
  await runtime.dispose()
})

test('a stale expiry timer cannot invalidate a newer relay session', async () => {
  const timers = []
  const streamSignals = []
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({
        accessToken: streamSignals.length ? 'session-two' : 'session-one',
        expiresAt: streamSignals.length ? 30_000 : 20_000
      }),
      deleteSession: async () => undefined,
      consumeEvents: async (_token, _onEvent, signal) => {
        streamSignals.push(signal)
        return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => undefined
  })
  runtime.accept(account, { idToken: 'proof-one', nonce: 'nonce_1' })
  await turn()
  await turn()
  const firstExpiry = timers.find((timer) => timer.delay === 19_000)
  runtime.accept(account, { idToken: 'proof-two', nonce: 'nonce_2' })
  await turn()
  await turn()
  assert.equal(streamSignals.length, 2)
  firstExpiry.callback()
  assert.equal(streamSignals[1].aborted, false)
  runtime.disconnect(account)
})

function refreshHarness(overrides = {}) {
  const timers = []
  const calls = { refresh: [], deleted: [], streams: [], saved: [], removed: [] }
  const stored = new Map(overrides.stored ?? [])
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({
        accessToken: 'session-one',
        expiresAt: 100_000,
        refreshToken: 'refresh-one'
      }),
      refreshSession:
        overrides.refreshSession ??
        (async (token) => {
          calls.refresh.push(token)
          return { accessToken: 'session-two', expiresAt: 200_000, refreshToken: 'refresh-two' }
        }),
      deleteSession: async (token) => calls.deleted.push(token),
      consumeEvents: async (token, _onEvent, signal) => {
        calls.streams.push(token)
        return new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
      }
    },
    credentials: {
      read: async (id) => stored.get(id) ?? null,
      write: async (id, token) => (calls.saved.push(token), stored.set(id, token)),
      delete: async (id) => (calls.removed.push(id), stored.delete(id))
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => undefined
  })
  return { runtime, timers, calls, stored }
}

test('a refreshable session is saved and renewed before expiry without logging out', async () => {
  const { runtime, timers, calls } = refreshHarness()
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  assert.deepEqual(calls.saved, ['refresh-one'])
  const renewTimer = timers.find((timer) => timer.delay === 100_000 - 60_000 - 1000)
  assert.ok(renewTimer)
  renewTimer.callback()
  await turn()
  await turn()
  assert.deepEqual(calls.refresh, ['refresh-one'])
  assert.deepEqual(calls.streams, ['session-one', 'session-two'])
  assert.deepEqual(calls.saved, ['refresh-one', 'refresh-two'])
  assert.deepEqual(calls.deleted, [])
})

test('resume reattaches a stored refresh token and quitting keeps the server session', async () => {
  const { runtime, calls } = refreshHarness({ stored: [[account, 'refresh-saved']] })
  await runtime.resume(account)
  await turn()
  await turn()
  assert.deepEqual(calls.refresh, ['refresh-saved'])
  assert.deepEqual(calls.streams, ['session-two'])
  await runtime.dispose()
  assert.deepEqual(calls.deleted, [])
  assert.deepEqual(calls.removed, [])
})

test('a dead refresh token is forgotten while a transient failure retries later', async () => {
  const dead = refreshHarness({
    stored: [[account, 'refresh-saved']],
    refreshSession: async () => {
      throw new relayClientModule.RelayFailure('unauthorized')
    }
  })
  await dead.runtime.resume(account)
  await turn()
  await turn()
  assert.deepEqual(dead.calls.removed, [account])
  assert.equal(dead.timers.length, 0)

  let attempts = 0
  const flaky = refreshHarness({
    stored: [[account, 'refresh-saved']],
    refreshSession: async () => {
      attempts += 1
      throw new relayClientModule.RelayFailure('network_error')
    }
  })
  await flaky.runtime.resume(account)
  await turn()
  await turn()
  assert.deepEqual(flaky.calls.removed, [])
  assert.equal(flaky.timers.at(-1).delay, 60_000)
  flaky.timers.at(-1).callback()
  await turn()
  await turn()
  assert.equal(attempts, 2)
  assert.equal(flaky.timers.at(-1).delay, 120_000)
  // Disconnect cancels the pending retry.
  flaky.runtime.disconnect(account)
  flaky.timers.at(-1).callback()
  await turn()
  assert.equal(attempts, 2)
})

test('disconnect logs out and forgets the refresh token; a new login does not log out', async () => {
  const { runtime, calls } = refreshHarness()
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_2' })
  await turn()
  await turn()
  assert.deepEqual(calls.deleted, [])
  runtime.disconnect(account)
  await turn()
  assert.deepEqual(calls.deleted, ['session-one'])
  assert.deepEqual(calls.removed, [account])
})
