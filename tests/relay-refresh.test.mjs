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

test('relay bootstrap separates missing proof, absent credentials, read failure and write failure', async () => {
  const diagnostics = []
  let sessionCalls = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => {
        sessionCalls += 1
        return { accessToken: 'opaque-session', expiresAt: 100_000, refreshToken: 'opaque-refresh' }
      },
      refreshSession: async () => ({ accessToken: 'opaque-session', expiresAt: 100_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async () => undefined
    },
    credentials: {
      read: async () => {
        throw new Error('SECRET credential path')
      },
      write: async () => {
        throw new Error('SECRET write')
      },
      delete: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event),
    setTimeout: () => 1,
    clearTimeout: () => undefined
  })
  runtime.accept(account, { idToken: undefined, nonce: 'nonce_1' })
  runtime.accept(account, { idToken: 'proof', nonce: undefined })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  await runtime.resume('account-two')
  assert.equal(sessionCalls, 1)
  assert.ok(
    diagnostics.some(
      (event) =>
        event.type === 'bootstrap' &&
        event.stage === 'proof_id_token' &&
        event.outcome === 'missing'
    )
  )
  assert.ok(
    diagnostics.some(
      (event) =>
        event.type === 'bootstrap' && event.stage === 'proof_nonce' && event.outcome === 'missing'
    )
  )
  assert.ok(
    diagnostics.some(
      (event) =>
        event.type === 'bootstrap' &&
        event.stage === 'credential_write' &&
        event.outcome === 'failure'
    )
  )
  assert.ok(
    diagnostics.some(
      (event) =>
        event.type === 'bootstrap' && event.stage === 'credentials' && event.outcome === 'failure'
    )
  )
  assert.equal(JSON.stringify(diagnostics).includes('SECRET'), false)
  await runtime.dispose()
})

test('relay resume distinguishes no credential store from a missing saved token', async () => {
  const diagnostics = []
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'unused', expiresAt: 100_000 }),
      refreshSession: async () => ({ accessToken: 'unused', expiresAt: 100_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event)
  })
  await runtime.resume('without-store')
  assert.deepEqual(
    diagnostics.map(({ stage, outcome }) => [stage, outcome]),
    [['credentials', 'unavailable']]
  )
  await runtime.dispose()
})

test('late saved-token read after disconnect and reconnect is not recorded for the new session', async () => {
  const diagnostics = []
  let finishRead
  let sessionCalls = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => {
        sessionCalls += 1
        return { accessToken: `session-${sessionCalls}`, expiresAt: 100_000 }
      },
      refreshSession: async () => ({ accessToken: 'refreshed', expiresAt: 100_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async () => undefined
    },
    credentials: {
      read: () => new Promise((resolve) => (finishRead = resolve)),
      write: async () => undefined,
      delete: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event),
    setTimeout: () => 1,
    clearTimeout: () => undefined
  })
  const staleResume = runtime.resume(account)
  await turn()
  runtime.disconnect(account)
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce' })
  await turn()
  finishRead('old-refresh-token')
  await staleResume
  await turn()
  assert.equal(
    diagnostics.some((event) => event.type === 'bootstrap' && event.stage === 'credentials'),
    false,
    JSON.stringify(diagnostics)
  )
  await runtime.dispose()
})

test('late saved-token read after disconnect cannot resume a removed connection', async () => {
  let finishRead
  let refreshCalls = 0
  let streamCalls = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'unused', expiresAt: 100_000 }),
      refreshSession: async () => {
        refreshCalls += 1
        return { accessToken: 'stale-session', expiresAt: 100_000 }
      },
      deleteSession: async () => undefined,
      consumeEvents: async () => {
        streamCalls += 1
      }
    },
    credentials: {
      read: () => new Promise((resolve) => (finishRead = resolve)),
      write: async () => undefined,
      delete: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined
  })
  const staleResume = runtime.resume(account)
  await turn()
  runtime.disconnect(account)
  finishRead('stale-refresh-token')
  await staleResume
  await turn()
  assert.equal(refreshCalls, 0)
  assert.equal(streamCalls, 0)
  await runtime.dispose()
})

test('late saved-token read after runtime disposal cannot reopen a relay session', async () => {
  let finishRead
  let refreshCalls = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'unused', expiresAt: 100_000 }),
      refreshSession: async () => {
        refreshCalls += 1
        return { accessToken: 'stale-session', expiresAt: 100_000 }
      },
      deleteSession: async () => undefined,
      consumeEvents: async () => undefined
    },
    credentials: {
      read: () => new Promise((resolve) => (finishRead = resolve)),
      write: async () => undefined,
      delete: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    setTimeout: () => 1,
    clearTimeout: () => undefined
  })
  const staleResume = runtime.resume(account)
  await turn()
  await runtime.dispose()
  finishRead('stale-refresh-token')
  await staleResume
  assert.equal(refreshCalls, 0)
})

test('late credential write completion after disconnect and reconnect is not recorded', async () => {
  const diagnostics = []
  let finishWrite
  let sessionCalls = 0
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => {
        sessionCalls += 1
        return {
          accessToken: `session-${sessionCalls}`,
          expiresAt: 100_000,
          ...(sessionCalls === 1 ? { refreshToken: 'refresh-token' } : {})
        }
      },
      deleteSession: async () => undefined,
      consumeEvents: async () => undefined
    },
    credentials: {
      read: async () => null,
      write: () => new Promise((resolve) => (finishWrite = resolve)),
      delete: async () => undefined
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event),
    setTimeout: () => 1,
    clearTimeout: () => undefined
  })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce' })
  await turn()
  await turn()
  runtime.disconnect(account)
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce' })
  await turn()
  finishWrite()
  await turn()
  assert.equal(
    diagnostics.some((event) => event.type === 'bootstrap' && event.stage === 'credential_write'),
    false
  )
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
