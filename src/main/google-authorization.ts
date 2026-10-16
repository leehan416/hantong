import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { GoogleOAuthConfig } from './google-oauth-config'
import { createPkcePair, type PkceCrypto } from './google-pkce'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_SCOPE = 'openid email https://www.googleapis.com/auth/gmail.metadata'
const CALLBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 10_000

export type AuthorizationErrorCode =
  'cancelled' | 'timeout' | 'browser_error' | 'server_error' | 'provider_error'

export class AuthorizationError extends Error {
  constructor(readonly code: AuthorizationErrorCode) {
    super(`Google authorization ${code.replaceAll('_', ' ')}`)
    this.name = 'AuthorizationError'
  }
}

export interface AuthorizationCode {
  readonly code: string
  readonly verifier: string
  readonly redirectUri: string
}

export interface GoogleAuthorizationOptions {
  readonly openExternal: (url: string) => Promise<void>
  readonly timeoutMs?: number
  readonly crypto?: PkceCrypto
  readonly createServer?: (
    listener: (request: IncomingMessage, response: ServerResponse) => void
  ) => Server
}

export interface GoogleAuthorizationOperation {
  readonly result: Promise<AuthorizationCode>
  cancel(): void
}

const successPage =
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Hantong</title></head><body><p lang="ko">Google 인증 응답을 받았습니다. 한통으로 돌아가 연결 상태를 확인해 주세요.</p><p lang="en">Google authorization response received. Return to Hantong to check the connection.</p></body></html>'
const failurePage =
  '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Hantong</title></head><body><p lang="ko">Google 인증을 완료하지 못했습니다. 한통으로 돌아가 다시 시도해 주세요.</p><p lang="en">Google authorization could not be completed. Return to Hantong and try again.</p></body></html>'

export function startGoogleAuthorization(
  config: GoogleOAuthConfig,
  options: GoogleAuthorizationOptions
): GoogleAuthorizationOperation {
  const crypto = options.crypto ?? { randomBytes, createHash }
  const pkce = createPkcePair(crypto)
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000
  let server: Server | undefined
  let redirectUri: string | undefined
  let settled = false
  let callbackClaimed = false
  let resolveResult: (value: AuthorizationCode) => void = () => undefined
  let rejectResult: (reason: AuthorizationError) => void = () => undefined

  const result = new Promise<AuthorizationCode>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // The caller can attach after startup; this keeps an early setup failure handled meanwhile.
  void result.catch(() => undefined)

  const closeServer = (): void => {
    if (timeout) clearTimeout(timeout)
    if (server) {
      server.close(() => undefined)
      server.closeAllConnections()
    }
  }

  const finish = (error?: AuthorizationError, value?: AuthorizationCode): void => {
    if (settled) return
    settled = true
    closeServer()
    if (error) rejectResult(error)
    else if (value) resolveResult(value)
    else rejectResult(new AuthorizationError('server_error'))
  }

  const timeout = setTimeout(() => finish(new AuthorizationError('timeout')), timeoutMs)

  const sendPage = (
    response: ServerResponse,
    status: number,
    success: boolean,
    done?: () => void
  ): void => {
    response.writeHead(status, {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    })
    response.end(success ? successPage : failurePage, done)
  }

  const handleCallback = (request: IncomingMessage, response: ServerResponse): void => {
    if (settled || callbackClaimed) {
      sendPage(response, 400, false)
      return
    }
    const expectedRedirect = redirectUri
    if (!expectedRedirect) {
      sendPage(response, 503, false)
      return
    }
    const expected = new URL(expectedRedirect)
    const expectedAuthority = `${CALLBACK_HOST}:${expected.port}`
    if (request.method !== 'GET') {
      sendPage(response, 405, false)
      return
    }
    if (request.headers.host !== expectedAuthority) {
      sendPage(response, 400, false)
      return
    }
    const requestTarget = request.url ?? '/'
    if (!requestTarget.startsWith('/') || requestTarget.startsWith('//')) {
      sendPage(response, 400, false)
      return
    }
    let callback: URL
    try {
      callback = new URL(requestTarget, `http://${expectedAuthority}`)
    } catch {
      sendPage(response, 400, false)
      return
    }
    if (callback.origin !== expected.origin || callback.host !== expectedAuthority) {
      sendPage(response, 400, false)
      return
    }
    if (callback.pathname !== '/') {
      sendPage(response, 404, false)
      return
    }

    const keys = new Set<string>()
    for (const [key] of callback.searchParams) {
      if (keys.has(key)) {
        sendPage(response, 400, false)
        return
      }
      keys.add(key)
    }
    const states = callback.searchParams.getAll('state')
    if (states.length !== 1 || !states[0]) {
      sendPage(response, 400, false)
      return
    }
    const receivedState = Buffer.from(states[0])
    const expectedState = Buffer.from(pkce.state)
    if (
      receivedState.length !== expectedState.length ||
      !timingSafeEqual(receivedState, expectedState)
    ) {
      sendPage(response, 400, false)
      return
    }

    const codes = callback.searchParams.getAll('code')
    const errors = callback.searchParams.getAll('error')
    const hasCode = codes.length === 1 && codes[0].length > 0
    const hasError = errors.length === 1 && errors[0].length > 0
    if (
      hasCode === hasError ||
      (codes.length > 0 && !hasCode) ||
      (errors.length > 0 && !hasError)
    ) {
      sendPage(response, 400, false)
      return
    }
    callbackClaimed = true
    const complete = (): void => {
      if (hasError) finish(new AuthorizationError('provider_error'))
      else
        finish(undefined, {
          code: codes[0],
          verifier: pkce.verifier,
          redirectUri: expectedRedirect
        })
    }
    response.once('close', complete)
    if (hasError) {
      sendPage(response, 200, false, complete)
      return
    }

    sendPage(response, 200, true, complete)
  }

  const makeServer = options.createServer ?? createServer
  try {
    server = makeServer(handleCallback)
    server.headersTimeout = REQUEST_TIMEOUT_MS
    server.requestTimeout = REQUEST_TIMEOUT_MS
    server.keepAliveTimeout = 1000
    server.setTimeout(REQUEST_TIMEOUT_MS, (socket) => socket.destroy())
    server.once('error', () => finish(new AuthorizationError('server_error')))
    server.listen(0, CALLBACK_HOST, () => {
      if (!server) return
      if (settled) {
        if (server.listening) closeServer()
        return
      }
      const address = server.address()
      if (!address || typeof address === 'string') {
        finish(new AuthorizationError('server_error'))
        return
      }
      redirectUri = `http://${CALLBACK_HOST}:${address.port}/`
      const authorizationUrl = new URL(AUTHORIZATION_ENDPOINT)
      authorizationUrl.searchParams.set('client_id', config.clientId)
      authorizationUrl.searchParams.set('redirect_uri', redirectUri)
      authorizationUrl.searchParams.set('response_type', 'code')
      authorizationUrl.searchParams.set('scope', OAUTH_SCOPE)
      authorizationUrl.searchParams.set('access_type', 'offline')
      authorizationUrl.searchParams.set('prompt', 'consent select_account')
      authorizationUrl.searchParams.set('code_challenge', pkce.challenge)
      authorizationUrl.searchParams.set('code_challenge_method', 'S256')
      authorizationUrl.searchParams.set('state', pkce.state)
      void Promise.resolve()
        .then(() => (settled ? undefined : options.openExternal(authorizationUrl.href)))
        .catch(() => finish(new AuthorizationError('browser_error')))
    })
  } catch {
    finish(new AuthorizationError('server_error'))
  }

  return {
    result,
    cancel: () => finish(new AuthorizationError('cancelled'))
  }
}
