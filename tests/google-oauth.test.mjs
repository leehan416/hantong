/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const config = loadTypeScript(new URL('../src/main/google-oauth-config.ts', import.meta.url))
const pkce = loadTypeScript(new URL('../src/main/google-pkce.ts', import.meta.url))
const authorization = loadTypeScript(
  new URL('../src/main/google-authorization.ts', import.meta.url)
)

const clientId = 'desktop-client.apps.googleusercontent.com'

function openCapture() {
  let resolveOpened
  const opened = new Promise((resolve) => (resolveOpened = resolve))
  return {
    opened,
    openExternal: async (url) => resolveOpened(url)
  }
}

function httpBoundary({ listenError, deferListen = false, deferResponseEnd = false } = {}) {
  const servers = []
  return {
    servers,
    createServer(listener) {
      const server = new EventEmitter()
      server.headersTimeout = 0
      server.requestTimeout = 0
      server.keepAliveTimeout = 0
      server.setTimeout = () => server
      server.listen = (_port, _host, callback) => {
        server.startListening = () => {
          if (listenError) {
            server.emit('error', listenError)
            return
          }
          server.listening = true
          callback()
        }
        if (!deferListen) queueMicrotask(server.startListening)
      }
      server.address = () => ({ address: '127.0.0.1', family: 'IPv4', port: 54321 })
      server.close = (callback) => {
        server.closed = true
        server.closeCalls = (server.closeCalls ?? 0) + 1
        server.listening = false
        callback?.()
      }
      server.closeAllConnections = () => {
        server.connectionsClosed = true
      }
      server.dispatch = (path, { method = 'GET', host = '127.0.0.1:54321' } = {}) => {
        const response = Object.assign(new EventEmitter(), {
          headers: {},
          writeHead(status, headers) {
            this.status = status
            this.headers = headers
          },
          end(body, callback) {
            this.body = body
            if (deferResponseEnd) this.endCallback = callback
            else {
              this.writableFinished = true
              callback?.()
            }
          }
        })
        listener({ method, headers: { host }, url: path }, response)
        return response
      }
      servers.push(server)
      return server
    }
  }
}

test('Google Desktop client ID must be present and use the Google client domain', () => {
  assert.equal(
    config.loadGoogleOAuthConfig({ HANTONG_GOOGLE_CLIENT_ID: clientId }).clientId,
    clientId
  )
  for (const environment of [
    {},
    { HANTONG_GOOGLE_CLIENT_ID: '' },
    { HANTONG_GOOGLE_CLIENT_ID: 'not-a-google-client' },
    { HANTONG_GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com?x=1' }
  ]) {
    assert.throws(() => config.loadGoogleOAuthConfig(environment), /HANTONG_GOOGLE_CLIENT_ID/)
  }
})

test('PKCE uses S256 and creates a fresh URL-safe state and verifier', () => {
  const crypto = { randomBytes, createHash }
  const first = pkce.createPkcePair(crypto)
  const second = pkce.createPkcePair(crypto)
  assert.match(first.state, /^[A-Za-z0-9_-]{43}$/)
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(first.state, second.state)
  assert.notEqual(first.verifier, second.verifier)
  assert.equal(first.challenge, createHash('sha256').update(first.verifier).digest('base64url'))
})

test('PKCE S256 matches the RFC 7636 known vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  let calls = 0
  const pair = pkce.createPkcePair({
    randomBytes: (size) =>
      ++calls === 1 ? Buffer.alloc(size, 1) : Buffer.from(verifier, 'base64url'),
    createHash
  })
  assert.equal(pair.verifier, verifier)
  assert.equal(pair.challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})

test('authorization opens a Desktop OAuth URL in the injected system browser', async () => {
  const capture = openCapture()
  const http = httpBoundary()
  const operation = authorization.startGoogleAuthorization(
    { clientId },
    { openExternal: capture.openExternal, timeoutMs: 5000, createServer: http.createServer }
  )
  const openedUrl = await capture.opened
  const url = new URL(openedUrl)
  assert.equal(url.origin, 'https://accounts.google.com')
  assert.equal(url.pathname, '/o/oauth2/v2/auth')
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('client_id'), clientId)
  assert.equal(url.searchParams.get('access_type'), 'offline')
  assert.deepEqual(url.searchParams.getAll('scope'), [
    'openid email https://www.googleapis.com/auth/gmail.metadata'
  ])
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.has('code_challenge'), true)
  assert.equal(url.searchParams.has('state'), true)
  assert.equal(url.searchParams.get('prompt'), 'consent select_account')
  operation.cancel()
  await assert.rejects(operation.result, { code: 'cancelled' })
  assert.equal(http.servers[0].closed, true)
  assert.equal(http.servers[0].connectionsClosed, true)
})

test('valid callback returns code, verifier and exact dynamic redirect URI once', async () => {
  const capture = openCapture()
  const http = httpBoundary()
  let counter = 0
  const crypto = {
    randomBytes: (size) => Buffer.alloc(size, ++counter),
    createHash
  }
  const operation = authorization.startGoogleAuthorization(
    { clientId },
    { openExternal: capture.openExternal, timeoutMs: 5000, crypto, createServer: http.createServer }
  )
  const openedUrl = await capture.opened
  const url = new URL(openedUrl)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  const response = http.servers[0].dispatch(
    `/?code=sample-code&state=${url.searchParams.get('state')}`
  )
  assert.equal(response.status, 200)
  assert.match(response.body, /<p lang="ko">/)
  assert.match(response.body, /<p lang="en">/)
  assert.match(response.body, /authorization response received/i)
  assert.match(response.body, /인증 응답을 받았습니다/)
  assert.match(response.headers['Content-Security-Policy'], /default-src 'none'/)
  assert.equal(response.headers['Cache-Control'], 'no-store')
  assert.doesNotMatch(response.body, /sample-code|state=/)
  const result = await operation.result
  assert.equal(result.code, 'sample-code')
  assert.equal(result.verifier, Buffer.alloc(32, 2).toString('base64url'))
  assert.equal(result.redirectUri, redirect.href)
  assert.equal(http.servers[0].closed, true)
})

test('the first valid callback is claimed immediately and client disconnect still settles it', async () => {
  const capture = openCapture()
  const http = httpBoundary({ deferResponseEnd: true })
  const operation = authorization.startGoogleAuthorization(
    { clientId },
    { openExternal: capture.openExternal, timeoutMs: 5000, createServer: http.createServer }
  )
  const url = new URL(await capture.opened)
  const state = url.searchParams.get('state')
  const firstResponse = http.servers[0].dispatch(`/?code=first&state=${state}`)
  const secondResponse = http.servers[0].dispatch(`/?code=second&state=${state}`)
  assert.equal(firstResponse.status, 200)
  assert.equal(secondResponse.status, 400)
  firstResponse.emit('close')
  const result = await operation.result
  assert.equal(result.code, 'first')
  assert.equal(http.servers[0].closed, true)
})

test('authorization errors and duplicate callback parameters do not disclose input', async () => {
  const capture = openCapture()
  const http = httpBoundary()
  const operation = authorization.startGoogleAuthorization(
    { clientId },
    { openExternal: capture.openExternal, timeoutMs: 5000, createServer: http.createServer }
  )
  const openedUrl = await capture.opened
  const url = new URL(openedUrl)
  const state = url.searchParams.get('state')
  for (const query of [
    `code=a&code=b&state=${state}`,
    `error=access_denied&error=other&state=${state}`,
    `code=a&error=denied&state=${state}`,
    `code=a&state=${state}&state=${state}`
  ]) {
    const response = http.servers[0].dispatch(`/?${query}`)
    assert.equal(response.status, 400)
    assert.doesNotMatch(response.body, /secret|access_denied|code=|state=/)
  }
  const response = http.servers[0].dispatch(
    `/?error=access_denied&error_description=secret&state=${state}`
  )
  assert.equal(response.status, 200)
  assert.doesNotMatch(response.body, /access_denied|state=/)
  assert.match(response.body, /<p lang="ko">/)
  assert.match(response.body, /<p lang="en">/)
  assert.match(response.body, /인증을 완료하지 못했습니다/)
  assert.match(response.body, /could not be completed/i)
  await assert.rejects(operation.result, { code: 'provider_error' })
})

test('wrong state, path, method and host leave the valid callback pending', async () => {
  const capture = openCapture()
  const http = httpBoundary()
  const operation = authorization.startGoogleAuthorization(
    { clientId },
    { openExternal: capture.openExternal, timeoutMs: 5000, createServer: http.createServer }
  )
  const openedUrl = await capture.opened
  const url = new URL(openedUrl)
  const redirect = new URL(url.searchParams.get('redirect_uri'))
  const state = url.searchParams.get('state')
  assert.equal(http.servers[0].dispatch('/?code=bad&state=wrong').status, 400)
  assert.equal(http.servers[0].dispatch(`/other?code=bad&state=${state}`).status, 404)
  assert.equal(
    http.servers[0].dispatch(`/?code=bad&state=${state}`, { method: 'POST' }).status,
    405
  )
  assert.equal(
    http.servers[0].dispatch(`/?code=ok&state=${state}`, { host: `localhost:${redirect.port}` })
      .status,
    400
  )
  assert.equal(
    http.servers[0].dispatch(`http://127.0.0.1:${redirect.port}/?code=ok&state=${state}`).status,
    400
  )
  assert.equal(
    http.servers[0].dispatch(`//127.0.0.1:${redirect.port}/?code=ok&state=${state}`).status,
    400
  )
  operation.cancel()
  await assert.rejects(operation.result, { code: 'cancelled' })
})

test('browser launch failure, cancellation and timeout reject and close the listener', async () => {
  const diagnostics = []
  const launchHttp = httpBoundary()
  const launchFailure = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: () => {
        throw new Error('browser failure')
      },
      reportFailure: (code) => {
        diagnostics.push(code)
        throw new Error('observer failure')
      },
      timeoutMs: 5000,
      createServer: launchHttp.createServer
    }
  )
  await assert.rejects(launchFailure.result, { code: 'browser_error' })
  assert.deepEqual(diagnostics, ['browser_error'])
  assert.equal(launchHttp.servers[0].closed, true)

  const cancelHttp = httpBoundary()
  const cancelled = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {},
      reportFailure: (code) => diagnostics.push(code),
      timeoutMs: 5000,
      createServer: cancelHttp.createServer
    }
  )
  cancelled.cancel()
  await assert.rejects(cancelled.result, { code: 'cancelled' })
  assert.deepEqual(diagnostics, ['browser_error'])
  assert.equal(cancelHttp.servers[0].closed, true)

  const timeoutHttp = httpBoundary()
  const timedOut = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {},
      reportFailure: (code) => diagnostics.push(code),
      timeoutMs: 15,
      createServer: timeoutHttp.createServer
    }
  )
  await assert.rejects(timedOut.result, { code: 'timeout' })
  assert.deepEqual(diagnostics, ['browser_error', 'timeout'])
  assert.equal(timeoutHttp.servers[0].closed, true)
})

test('timeout and cancellation close listeners that bind late', async () => {
  const cancelHttp = httpBoundary({ deferListen: true })
  const cancelled = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {},
      timeoutMs: 5000,
      createServer: cancelHttp.createServer
    }
  )
  cancelled.cancel()
  await assert.rejects(cancelled.result, { code: 'cancelled' })
  cancelHttp.servers[0].startListening()
  assert.equal(cancelHttp.servers[0].listening, false)
  assert.equal(cancelHttp.servers[0].closeCalls, 2)

  const timeoutHttp = httpBoundary({ deferListen: true })
  const timedOut = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {},
      timeoutMs: 15,
      createServer: timeoutHttp.createServer
    }
  )
  await assert.rejects(timedOut.result, { code: 'timeout' })
  timeoutHttp.servers[0].startListening()
  assert.equal(timeoutHttp.servers[0].listening, false)
  assert.equal(timeoutHttp.servers[0].closeCalls, 2)
})

test('listener and server creation failures reject without opening the browser', async () => {
  let opened = false
  const listenerHttp = httpBoundary({ listenError: new Error('bind details') })
  const listenerFailure = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {
        opened = true
      },
      timeoutMs: 5000,
      createServer: listenerHttp.createServer
    }
  )
  await assert.rejects(listenerFailure.result, { code: 'server_error' })
  assert.equal(opened, false)
  assert.equal(listenerHttp.servers[0].closed, true)

  const creationFailure = authorization.startGoogleAuthorization(
    { clientId },
    {
      openExternal: async () => {
        opened = true
      },
      createServer: () => {
        throw new Error('server details')
      }
    }
  )
  await assert.rejects(creationFailure.result, { code: 'server_error' })
  assert.equal(opened, false)
})
