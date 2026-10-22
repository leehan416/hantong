/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const exchange = loadTypeScript(new URL('../src/main/google-token-exchange.ts', import.meta.url))
const connection = loadTypeScript(new URL('../src/main/google-connection.ts', import.meta.url))

const clientId = 'desktop-client.apps.googleusercontent.com'
const code = {
  code: 'authorization-code',
  verifier: 'pkce-verifier',
  redirectUri: 'http://127.0.0.1:32100/'
}
const tokens = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 1_800_003_600_000
}
const requestNow = 1_800_000_000_000

function response(status, value, extra = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    json: async () => value,
    ...extra
  }
}

function tokenOptions(fetch, overrides = {}) {
  return {
    fetch,
    signal: new AbortController().signal,
    now: () => requestNow,
    timeoutMs: 5000,
    ...overrides
  }
}

function makeConnectionDependencies(overrides = {}) {
  const calls = { auth: 0, exchange: 0, profile: 0, identity: 0, authCancelled: 0 }
  const snapshots = [
    { accountExists: true, emailAddress: 'owner+tag@example.com' },
    { accountExists: true, emailAddress: 'OWNER+TAG@example.com' }
  ]
  const dependencies = {
    calls,
    readWebIdentity: async (accountId, signal) => {
      assert.equal(typeof accountId, 'string')
      assert.equal(signal.aborted, false)
      calls.identity += 1
      return snapshots.shift()
    },
    startAuthorization: () => {
      calls.auth += 1
      return { result: Promise.resolve(code), cancel: () => calls.authCancelled++ }
    },
    exchangeCode: async (_config, receivedCode, signal) => {
      assert.equal(signal.aborted, false)
      calls.exchange += 1
      assert.equal(receivedCode, code)
      return tokens
    },
    fetchProfile: async (accessToken, signal) => {
      assert.equal(signal.aborted, false)
      calls.profile += 1
      assert.equal(accessToken, tokens.accessToken)
      return 'owner+tag@example.com'
    },
    ...overrides
  }
  return { dependencies, calls, snapshots }
}

test('cancellation between response headers and body parsing is observed without an unhandled rejection', async () => {
  const externalController = new AbortController()
  await assert.rejects(
    exchange.exchangeGoogleAuthorizationCode(
      { clientId },
      code,
      tokenOptions(
        async () =>
          response(200, undefined, {
            json: () => {
              externalController.abort()
              return Promise.reject(new Error('AbortError with private response details'))
            }
          }),
        { signal: externalController.signal }
      )
    ),
    { code: 'cancelled' }
  )
})

test('cancellation aborts pending work and prevents late completion', async () => {
  let resolveExchange
  let receivedSignal
  const { dependencies, calls } = makeConnectionDependencies({
    exchangeCode: (_config, _code, signal) => {
      receivedSignal = signal
      return new Promise((resolve) => (resolveExchange = resolve))
    }
  })
  const operation = connection.startGoogleConnection('account-a', { clientId }, dependencies)
  await new Promise((resolve) => setImmediate(resolve))
  operation.cancel()
  await assert.rejects(operation.result, { code: 'cancelled' })
  assert.equal(receivedSignal.aborted, true)
  resolveExchange(tokens)
  assert.equal(calls.profile, 0)
})

test('a stalled Main web-identity lookup is timeout-bounded and promptly cancellable', async () => {
  let resolveTimedLookup
  const timed = makeConnectionDependencies({
    identityTimeoutMs: 10,
    readWebIdentity: async () => new Promise((resolve) => (resolveTimedLookup = resolve))
  })
  await assert.rejects(
    connection.startGoogleConnection('account-a', { clientId }, timed.dependencies).result,
    { code: 'timeout' }
  )
  resolveTimedLookup({ accountExists: true, emailAddress: 'late@example.com' })
  await new Promise((resolve) => setImmediate(resolve))

  const cancelled = makeConnectionDependencies({
    readWebIdentity: async () => new Promise(() => {})
  })
  let lookupStarted
  let rejectLookup
  const started = new Promise((resolve) => (lookupStarted = resolve))
  cancelled.dependencies.readWebIdentity = async () => {
    lookupStarted()
    return new Promise((_resolve, reject) => (rejectLookup = reject))
  }
  const operation = connection.startGoogleConnection(
    'account-cancel',
    { clientId },
    cancelled.dependencies
  )
  await started
  operation.cancel()
  await assert.rejects(operation.result, { code: 'cancelled' })
  rejectLookup(new Error('late identity failure'))
  await new Promise((resolve) => setImmediate(resolve))
})

test('starting a newer connection cancels the earlier operation for that account only', async () => {
  let resolveFirstIdentity
  const first = makeConnectionDependencies({
    readWebIdentity: () => new Promise((resolve) => (resolveFirstIdentity = resolve))
  })
  const firstOperation = connection.startGoogleConnection(
    'account-a',
    { clientId },
    first.dependencies
  )
  await new Promise((resolve) => setImmediate(resolve))
  const second = makeConnectionDependencies()
  const secondOperation = connection.startGoogleConnection(
    'account-a',
    { clientId },
    second.dependencies
  )
  await assert.rejects(firstOperation.result, { code: 'cancelled' })
  resolveFirstIdentity({ accountExists: true, emailAddress: 'owner@example.com' })
  const result = await secondOperation.result
  assert.equal(result.emailAddress, 'owner+tag@example.com')
  assert.equal(first.calls.auth, 0)
})

test('starting a connection for another account does not cancel the first account', async () => {
  const accountA = makeConnectionDependencies()
  const accountB = makeConnectionDependencies()
  const operationA = connection.startGoogleConnection(
    'account-a',
    { clientId },
    accountA.dependencies
  )
  const operationB = connection.startGoogleConnection(
    'account-b',
    { clientId },
    accountB.dependencies
  )
  const [resultA, resultB] = await Promise.all([operationA.result, operationB.result])
  assert.equal(resultA.emailAddress, 'owner+tag@example.com')
  assert.equal(resultB.emailAddress, 'owner+tag@example.com')
})
