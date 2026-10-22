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

test('relay EOF retries with bounded backoff and stops after unauthorized response without logging out', async () => {
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
    random: () => 0.5,
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
  assert.deepEqual(deleted, [])
  now = 2000
  await runtime.dispose()
})

test('relay retry jitter stays between eighty and one hundred twenty percent', async () => {
  for (const [random, expected] of [
    [0, 800],
    [1, 1200]
  ]) {
    const timers = []
    const runtime = runtimeModule.createRelayRuntime({
      client: {
        createSession: async () => ({ accessToken: 'session', expiresAt: 60_000 }),
        deleteSession: async () => undefined,
        consumeEvents: async () => {
          throw new relayClientModule.RelayFailure('network_error')
        }
      },
      accountExists: () => true,
      now: () => 1000,
      random: () => random,
      onSignal: () => undefined,
      setTimeout: (callback, delay) => {
        const timer = { callback, delay }
        timers.push(timer)
        return timer
      },
      clearTimeout: () => undefined
    })
    runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
    await turn()
    await turn()
    assert.ok(timers.some((timer) => timer.delay === expected))
    runtime.disconnect(account)
  }
})

test('explicit relay reconnect retires a stale owned stream and reopens saved credentials', async () => {
  let streams = 0
  const stored = {
    read: async () => 'refresh',
    write: async () => undefined,
    delete: async () => undefined
  }
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'created', expiresAt: 60_000 }),
      refreshSession: async () => ({ accessToken: `refresh-${++streams}`, expiresAt: 60_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async (_token, _onEvent, signal) =>
        new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
    },
    credentials: stored,
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined
  })
  await runtime.resume(account)
  await turn()
  await turn()
  assert.equal(streams, 1)
  await runtime.reconnect(account)
  await turn()
  await turn()
  assert.equal(streams, 2)
  runtime.disconnect(account)
})

test('relay runtime reports session, stream failure and retry outcome with fixed codes', async () => {
  const timers = []
  const diagnostics = []
  const runtime = runtimeModule.createRelayRuntime({
    client: {
      createSession: async () => ({ accessToken: 'opaque-session', expiresAt: 100_000 }),
      deleteSession: async () => undefined,
      consumeEvents: async () => {
        throw new relayClientModule.RelayFailure('network_error')
      }
    },
    accountExists: () => true,
    now: () => 1000,
    onSignal: () => undefined,
    onDiagnostic: (event) => diagnostics.push(event),
    setTimeout: (callback, delay) => (timers.push({ callback, delay }), timers.length),
    clearTimeout: () => undefined
  })
  runtime.accept(account, { idToken: 'proof', nonce: 'nonce_1' })
  await turn()
  await turn()
  assert.deepEqual(
    diagnostics
      .filter((event) => event.type !== 'bootstrap')
      .map((event) => [event.type, event.outcome, event.code]),
    [
      ['session', 'success', undefined],
      ['transport', undefined, 'network_error'],
      ['reconnect', 'retry', 'network_error']
    ]
  )
  runtime.disconnect(account)
})
