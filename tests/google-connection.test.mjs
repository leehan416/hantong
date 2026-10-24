/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const config = loadTypeScript(new URL('../src/main/google-oauth-config.ts', import.meta.url))
const exchange = loadTypeScript(new URL('../src/main/google-token-exchange.ts', import.meta.url))
const connection = loadTypeScript(new URL('../src/main/google-connection.ts', import.meta.url))

const clientId = 'desktop-client.apps.googleusercontent.com'
const configWithSecret = { clientId, clientSecret: 'local-test-secret' }
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

function validTokenResponse(overrides = {}) {
  return {
    access_token: 'access-token',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'refresh-token',
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

test('Main OAuth config accepts an optional blank client secret without loading dotenv', () => {
  const withoutSecret = config.loadGoogleOAuthConfig({
    HANTONG_GOOGLE_CLIENT_ID: clientId,
    HANTONG_GOOGLE_CLIENT_SECRET: ''
  })
  assert.equal(withoutSecret.clientId, clientId)
  assert.equal(withoutSecret.clientSecret, undefined)
  assert.equal(
    config.loadGoogleOAuthConfig({
      HANTONG_GOOGLE_CLIENT_ID: clientId,
      HANTONG_GOOGLE_CLIENT_SECRET: '  test-secret  '
    }).clientSecret,
    'test-secret'
  )
})

test('authorization-code exchange uses the fixed HTTPS endpoint and keeps credentials out of the URL', async () => {
  let captured
  const result = await exchange.exchangeGoogleAuthorizationCode(
    configWithSecret,
    code,
    tokenOptions(async (url, init) => {
      captured = { url, init }
      return response(200, validTokenResponse())
    })
  )
  assert.equal(captured.url, 'https://oauth2.googleapis.com/token')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.redirect, 'error')
  assert.match(captured.init.headers['content-type'], /application\/x-www-form-urlencoded/)
  const body = new URLSearchParams(captured.init.body)
  assert.equal(body.get('grant_type'), 'authorization_code')
  assert.equal(body.get('code'), code.code)
  assert.equal(body.get('code_verifier'), code.verifier)
  assert.equal(body.get('redirect_uri'), code.redirectUri)
  assert.equal(body.get('client_id'), clientId)
  assert.equal(body.get('client_secret'), configWithSecret.clientSecret)
  assert.equal(result.accessToken, 'access-token')
  assert.equal(result.refreshToken, 'refresh-token')
  assert.equal(result.expiresAt, requestNow + 3_600_000)
})

test('token exchange omits an absent client secret', async () => {
  let body
  const payload = { access_token: 'access-token', token_type: 'Bearer', expires_in: 3600 }
  await exchange.exchangeGoogleAuthorizationCode(
    { clientId },
    code,
    tokenOptions(async (_url, init) => {
      body = new URLSearchParams(init.body)
      return response(200, payload)
    })
  )
  assert.equal(body.has('client_secret'), false)
})

test('OAuth keeps an optional ID token in Main memory and rejects malformed fields', async () => {
  const result = await exchange.exchangeGoogleAuthorizationCode(
    { clientId },
    code,
    tokenOptions(async () => response(200, validTokenResponse({ id_token: 'id-proof' })))
  )
  assert.equal(result.idToken, 'id-proof')
  for (const id_token of ['', 7, 'x'.repeat(16_385)]) {
    await assert.rejects(
      exchange.exchangeGoogleAuthorizationCode(
        { clientId },
        code,
        tokenOptions(async () => response(200, validTokenResponse({ id_token })))
      ),
      { code: 'invalid_response' }
    )
  }
})

test('invalid, incomplete, or expired token responses are rejected without exposing their contents', async () => {
  for (const payload of [
    null,
    {},
    validTokenResponse({ access_token: '' }),
    validTokenResponse({ token_type: 'Basic' }),
    validTokenResponse({ expires_in: 0 }),
    validTokenResponse({ expires_in: Number.POSITIVE_INFINITY }),
    validTokenResponse({ refresh_token: '' })
  ]) {
    await assert.rejects(
      exchange.exchangeGoogleAuthorizationCode(
        { clientId },
        code,
        tokenOptions(async () => response(200, payload))
      ),
      { code: 'invalid_response' }
    )
  }
})

test('provider refusal and redirects produce sanitized exchange errors', async () => {
  await assert.rejects(
    exchange.exchangeGoogleAuthorizationCode(
      { clientId },
      code,
      tokenOptions(async () =>
        response(400, { error: 'invalid_grant', error_description: 'private details' })
      )
    ),
    (error) => error.code === 'provider_error' && !error.message.includes('private details')
  )
  for (const redirectResponse of [
    response(302, {}),
    response(200, validTokenResponse(), { redirected: true })
  ]) {
    await assert.rejects(
      exchange.exchangeGoogleAuthorizationCode(
        { clientId },
        code,
        tokenOptions(async () => redirectResponse)
      ),
      { code: 'redirect_refused' }
    )
  }
})

test('network errors and request timeouts never expose URLs or provider details', async () => {
  await assert.rejects(
    exchange.exchangeGoogleAuthorizationCode(
      { clientId },
      code,
      tokenOptions(async () => {
        throw new Error('https://oauth2.googleapis.com/token access-token')
      })
    ),
    (error) => error.code === 'network_error' && !error.message.includes('access-token')
  )

  await assert.rejects(
    exchange.exchangeGoogleAuthorizationCode(
      { clientId },
      code,
      tokenOptions(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new Error('private timeout details'))
            )
          }),
        { timeoutMs: 10 }
      )
    ),
    (error) => error.code === 'timeout' && !error.message.includes('private')
  )
})

test('Gmail profile fetch uses bearer auth and validates the returned email address', async () => {
  let captured
  const email = await exchange.fetchGoogleProfileEmail(
    tokens.accessToken,
    tokenOptions(async (url, init) => {
      captured = { url, init }
      return response(200, { emailAddress: ' user+tag@example.com ' })
    })
  )
  assert.equal(captured.url, 'https://gmail.googleapis.com/gmail/v1/users/me/profile')
  assert.equal(captured.init.method, 'GET')
  assert.equal(captured.init.redirect, 'error')
  assert.equal(captured.init.headers.authorization, 'Bearer access-token')
  assert.equal(email, 'user+tag@example.com')
  for (const payload of [null, {}, { emailAddress: '' }, { emailAddress: 'not-an-email' }]) {
    await assert.rejects(
      exchange.fetchGoogleProfileEmail(
        tokens.accessToken,
        tokenOptions(async () => response(200, payload))
      ),
      { code: 'invalid_response' }
    )
  }
})

test('connection matches the per-account web identity only after the Gmail profile call', async () => {
  const { dependencies, calls } = makeConnectionDependencies()
  const operation = connection.startGoogleConnection('account-a', { clientId }, dependencies)
  const result = await operation.result
  assert.equal(result.emailAddress, 'owner+tag@example.com')
  assert.equal(result.tokens.accessToken, tokens.accessToken)
  assert.equal(calls.identity, 1)
  assert.equal(calls.auth, 1)
  assert.equal(calls.exchange, 1)
  assert.equal(calls.profile, 1)
})

test('relay challenge is requested before OAuth and returned only after both identities match', async () => {
  const calls = []
  const { dependencies } = makeConnectionDependencies({
    prepareRelayChallenge: async () => {
      calls.push('challenge')
      return 'nonce_abc'
    },
    startAuthorization: (_config, nonce) => {
      calls.push(`authorization:${nonce}`)
      return { result: Promise.resolve(code), cancel: () => undefined }
    }
  })
  const result = await connection.startGoogleConnection('account-a', { clientId }, dependencies)
    .result
  assert.deepEqual(calls, ['challenge', 'authorization:nonce_abc'])
  assert.equal(result.relayNonce, 'nonce_abc')
})

test('relay challenge failure falls back to Google OAuth without nonce', async () => {
  let nonce = 'uninitialized'
  const { dependencies } = makeConnectionDependencies({
    prepareRelayChallenge: async () => {
      throw new Error('private relay URL')
    },
    startAuthorization: (_config, suppliedNonce) => {
      nonce = suppliedNonce
      return { result: Promise.resolve(code), cancel: () => undefined }
    }
  })
  const result = await connection.startGoogleConnection('account-a', { clientId }, dependencies)
    .result
  assert.equal(nonce, undefined)
  assert.equal(Object.hasOwn(result, 'relayNonce'), false)
})

test('missing web identity never blocks browser authorization but returns no tokens', async () => {
  const { dependencies, calls } = makeConnectionDependencies({
    readWebIdentity: async () => ({ accountExists: true, emailAddress: null })
  })
  const operation = connection.startGoogleConnection('account-a', { clientId }, dependencies)
  await assert.rejects(operation.result, { code: 'identity_unavailable' })
  assert.equal(calls.auth, 1)
  assert.equal(calls.profile, 1)
})

test('deleted account and API identity mismatch cannot return tokens', async () => {
  const deleted = makeConnectionDependencies({
    readWebIdentity: async () => ({ accountExists: false, emailAddress: null })
  })
  await assert.rejects(
    connection.startGoogleConnection('account-a', { clientId }, deleted.dependencies).result,
    { code: 'account_missing' }
  )

  const mismatch = makeConnectionDependencies({
    fetchProfile: async () => 'different@example.com'
  })
  await assert.rejects(
    connection.startGoogleConnection('account-a', { clientId }, mismatch.dependencies).result,
    { code: 'identity_mismatch' }
  )
})

test('authorization denial and exchange failure return no token object', async () => {
  const denied = makeConnectionDependencies({
    startAuthorization: () => ({
      result: Promise.reject(
        Object.assign(new Error('access_token leaked?'), { code: 'provider_error' })
      ),
      cancel: () => {}
    })
  })
  await assert.rejects(
    connection.startGoogleConnection('account-a', { clientId }, denied.dependencies).result,
    (error) => error.code === 'authorization_failed' && !error.message.includes('access_token')
  )

  const failedExchange = makeConnectionDependencies({
    exchangeCode: async () => {
      throw Object.assign(new Error('raw response with token-secret'), { code: 'provider_error' })
    }
  })
  await assert.rejects(
    connection.startGoogleConnection('account-a', { clientId }, failedExchange.dependencies).result,
    (error) => error.code === 'provider_error' && !error.message.includes('token-secret')
  )
})
