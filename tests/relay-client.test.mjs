/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const relay = loadTypeScript(new URL('../src/main/relay-client.ts', import.meta.url))

function response(status, payload, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => payload
  }
}

test('relay challenge and session requests use fixed paths and validate bounded responses', async () => {
  const requests = []
  const client = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    fetch: async (url, init) => {
      requests.push({ url, init })
      return requests.length === 1
        ? response(200, { nonce: 'nonce_123', expires_in: 300 })
        : response(200, { access_token: 'opaque-token_123', token_type: 'Bearer', expires_in: 900 })
    },
    now: () => 1000
  })
  assert.equal((await client.fetchChallenge()).nonce, 'nonce_123')
  assert.deepEqual(
    { ...(await client.createSession('id-proof', 'nonce_123', 'install')) },
    {
      accessToken: 'opaque-token_123',
      expiresAt: 901000
    }
  )
  assert.equal(requests[0].url, 'https://relay.example/auth/challenge')
  assert.equal(requests[0].init.redirect, 'error')
  assert.equal(requests[1].url, 'https://relay.example/auth/session')
  assert.equal(requests[1].init.headers.authorization, undefined)
  assert.equal(requests[1].init.body.includes('id-proof'), true)
})

test('relay failures are sanitized and redirects are refused', async () => {
  const client = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    fetch: async (_url, init) => {
      assert.equal(init.redirect, 'error')
      return { ...response(302, { detail: 'private' }), status: 302, ok: false }
    },
    now: () => 1000
  })
  await assert.rejects(
    client.fetchChallenge(),
    (error) => error.code === 'redirect_refused' && !error.message.includes('private')
  )
})

test('relay HTTP timeouts and caller cancellation settle even when fetch ignores AbortSignal', async () => {
  const timed = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    fetch: async () => new Promise(() => {}),
    now: () => 1000,
    timeoutMs: 5
  })
  await assert.rejects(timed.fetchChallenge(), { code: 'timeout' })
  const controller = new AbortController()
  const cancelled = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    fetch: async () => new Promise(() => {}),
    now: () => 1000,
    timeoutMs: 5000
  })
  const operation = cancelled.fetchChallenge(controller.signal)
  controller.abort()
  await assert.rejects(operation, { code: 'cancelled' })
})

test('SSE parser accepts recognized normalized events across chunk boundaries', async () => {
  const chunks = [
    ': heartbeat\r\nevent: ready\r\ndata: {"resync":true}\r',
    '\n\r\nevent: mailbox_changed\ndata: {"historyId":\ndata: "42"}\n\n'
  ].map((chunk) => new TextEncoder().encode(chunk))
  const client = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    fetch: async () => ({
      status: 200,
      ok: true,
      redirected: false,
      headers: { get: () => 'text/event-stream; charset=utf-8' },
      body: {
        getReader: () => ({
          read: async () => {
            const value = chunks.shift()
            return value ? { done: false, value } : { done: true }
          },
          cancel: async () => undefined,
          releaseLock: () => undefined
        })
      }
    }),
    now: () => 1000
  })
  const received = []
  await client.consumeEvents('opaque-token', (event) => received.push(event))
  assert.deepEqual(
    received.map((event) => ({ ...event })),
    [
      { type: 'ready', resync: true },
      { type: 'mailbox_changed', historyId: '42' }
    ]
  )
})

test('SSE stream read failures remain retryable network errors and data buffers stay bounded', async () => {
  const makeClient = (read) =>
    relay.createRelayClient({
      baseUrl: 'https://relay.example',
      now: () => 1000,
      fetch: async () => ({
        status: 200,
        ok: true,
        redirected: false,
        headers: { get: () => 'text/event-stream' },
        body: {
          getReader: () => ({ read, cancel: async () => undefined, releaseLock: () => undefined })
        }
      })
    })
  await assert.rejects(
    makeClient(async () => {
      throw new Error('socket reset')
    }).consumeEvents('token', () => undefined),
    { code: 'network_error' }
  )
  let remaining = 7000
  await assert.rejects(
    makeClient(async () =>
      remaining-- > 0
        ? { done: false, value: new TextEncoder().encode('data:123456789\n') }
        : { done: true }
    ).consumeEvents('token', () => undefined),
    { code: 'invalid_response' }
  )
})

test('SSE body survives the request timeout and remains cancellable when its reader ignores abort', async () => {
  const external = new AbortController()
  let readStarted
  let settled = false
  const started = new Promise((resolve) => {
    readStarted = resolve
  })
  const client = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    now: () => 1000,
    timeoutMs: 5,
    streamIdleMs: 1000,
    fetch: async () => ({
      status: 200,
      ok: true,
      redirected: false,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: () => {
            readStarted()
            return new Promise(() => {})
          },
          cancel: async () => undefined,
          releaseLock: () => undefined
        })
      }
    })
  })
  const operation = client
    .consumeEvents('token', () => undefined, external.signal)
    .then(
      () => {
        settled = true
      },
      (error) => {
        settled = true
        throw error
      }
    )
  await started
  await new Promise((resolve) => setTimeout(resolve, 12))
  assert.equal(settled, false)
  external.abort()
  await assert.rejects(operation, { code: 'cancelled' })
})

test('bounded JSON body timeout and malformed UTF-8 fail with fixed relay codes', async () => {
  const bodyTimeout = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    now: () => 1000,
    timeoutMs: 5,
    fetch: async () => ({
      status: 200,
      ok: true,
      redirected: false,
      headers: { get: () => 'application/json' },
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: async () => undefined,
          releaseLock: () => undefined
        })
      }
    })
  })
  await assert.rejects(bodyTimeout.fetchChallenge(), { code: 'timeout' })
  const malformed = relay.createRelayClient({
    baseUrl: 'https://relay.example',
    now: () => 1000,
    fetch: async () => ({
      status: 200,
      ok: true,
      redirected: false,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => {
          let emitted = false
          return {
            read: async () =>
              emitted
                ? { done: true }
                : ((emitted = true), { done: false, value: new Uint8Array([0xff]) }),
            cancel: async () => undefined,
            releaseLock: () => undefined
          }
        }
      }
    })
  })
  await assert.rejects(
    malformed.consumeEvents('token', () => undefined),
    { code: 'invalid_response' }
  )
})
