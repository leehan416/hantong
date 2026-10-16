import { URLSearchParams } from 'node:url'
import type { AuthorizationCode } from './google-authorization'
import type { GoogleOAuthConfig } from './google-oauth-config'

export type GoogleOAuthFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'redirect_refused'
  | 'provider_error'
  | 'invalid_response'

export class GoogleOAuthFailure extends Error {
  constructor(readonly code: GoogleOAuthFailureCode) {
    super(`Google OAuth ${code.replaceAll('_', ' ')}`)
    this.name = 'GoogleOAuthFailure'
  }
}

export interface GoogleOAuthTokens {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
}

export interface GoogleRequestOptions {
  readonly fetch: typeof fetch
  readonly signal: AbortSignal
  readonly timeoutMs?: number
}

export interface GoogleTokenExchangeOptions extends GoogleRequestOptions {
  readonly now: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      operation.then(
        () => undefined,
        () => undefined
      )
      reject(new GoogleOAuthFailure('cancelled'))
      return
    }
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new GoogleOAuthFailure('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function requestJson(
  url: string,
  init: RequestInit,
  options: GoogleRequestOptions
): Promise<unknown> {
  if (options.signal.aborted) throw new GoogleOAuthFailure('cancelled')
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = (): void => controller.abort()
  options.signal.addEventListener('abort', relayAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? 15_000)

  try {
    const response = await raceAbort(
      options.fetch(url, { ...init, redirect: 'error', signal: controller.signal }),
      controller.signal
    )
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new GoogleOAuthFailure('redirect_refused')
    }
    if (!response.ok) throw new GoogleOAuthFailure('provider_error')
    try {
      return await raceAbort(response.json(), controller.signal)
    } catch (error) {
      if (timedOut) throw new GoogleOAuthFailure('timeout')
      if (options.signal.aborted) throw new GoogleOAuthFailure('cancelled')
      if (error instanceof GoogleOAuthFailure) throw error
      throw new GoogleOAuthFailure('invalid_response')
    }
  } catch (error) {
    if (timedOut) throw new GoogleOAuthFailure('timeout')
    if (options.signal.aborted) throw new GoogleOAuthFailure('cancelled')
    if (error instanceof GoogleOAuthFailure) throw error
    throw new GoogleOAuthFailure('network_error')
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', relayAbort)
  }
}

export async function exchangeGoogleAuthorizationCode(
  config: GoogleOAuthConfig,
  authorization: AuthorizationCode,
  options: GoogleTokenExchangeOptions
): Promise<GoogleOAuthTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code: authorization.code,
    code_verifier: authorization.verifier,
    grant_type: 'authorization_code',
    redirect_uri: authorization.redirectUri
  })
  if (config.clientSecret) body.set('client_secret', config.clientSecret)

  const payload = await requestJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    },
    options
  )
  if (!isRecord(payload)) throw new GoogleOAuthFailure('invalid_response')
  const accessToken = payload.access_token
  const tokenType = payload.token_type
  const expiresIn = payload.expires_in
  const hasRefreshToken = Object.hasOwn(payload, 'refresh_token')
  const refreshToken = payload.refresh_token
  if (
    typeof accessToken !== 'string' ||
    !accessToken.trim() ||
    typeof tokenType !== 'string' ||
    tokenType.toLowerCase() !== 'bearer' ||
    typeof expiresIn !== 'number' ||
    !Number.isFinite(expiresIn) ||
    expiresIn <= 0 ||
    (hasRefreshToken && (typeof refreshToken !== 'string' || !refreshToken.trim()))
  ) {
    throw new GoogleOAuthFailure('invalid_response')
  }
  let now: number
  try {
    now = options.now()
  } catch {
    throw new GoogleOAuthFailure('invalid_response')
  }
  const expiresAt = now + expiresIn * 1000
  if (!Number.isFinite(expiresAt)) throw new GoogleOAuthFailure('invalid_response')
  const optionalRefreshToken = typeof refreshToken === 'string' ? refreshToken : undefined
  return {
    accessToken,
    ...(optionalRefreshToken ? { refreshToken: optionalRefreshToken } : {}),
    expiresAt
  }
}

export async function fetchGoogleProfileEmail(
  accessToken: string,
  options: GoogleRequestOptions
): Promise<string> {
  if (!accessToken.trim()) throw new GoogleOAuthFailure('invalid_response')
  const payload = await requestJson(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`
      }
    },
    options
  )
  if (!isRecord(payload) || typeof payload.emailAddress !== 'string') {
    throw new GoogleOAuthFailure('invalid_response')
  }
  const emailAddress = payload.emailAddress.trim()
  if (!/^[^\s@]+@[^\s@]+$/.test(emailAddress)) {
    throw new GoogleOAuthFailure('invalid_response')
  }
  return emailAddress
}
