import type { AuthorizationCode, GoogleAuthorizationOperation } from './google-authorization'
import type { GoogleOAuthConfig } from './google-oauth-config'
import type { GoogleOAuthTokens } from './google-token-exchange'
import type {
  OAuthDiagnosticCode,
  OAuthDiagnosticOutcome,
  OAuthDiagnosticStage
} from './main-diagnostics-types'

export type GoogleConnectionFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'authorization_failed'
  | 'network_error'
  | 'redirect_refused'
  | 'provider_error'
  | 'invalid_response'
  | 'identity_unavailable'
  | 'account_missing'
  | 'identity_changed'
  | 'identity_mismatch'

export class GoogleConnectionFailure extends Error {
  constructor(readonly code: GoogleConnectionFailureCode) {
    super(`Google connection ${code.replaceAll('_', ' ')}`)
    this.name = 'GoogleConnectionFailure'
  }
}

export interface WebIdentitySnapshot {
  readonly accountExists: boolean
  readonly emailAddress: string | null
}

export interface GoogleConnectionResult {
  readonly emailAddress: string
  readonly tokens: GoogleOAuthTokens
  readonly relayNonce?: string
}

export interface GoogleConnectionDependencies {
  // This Main-owned lookup must read the requested account, not Renderer input or the active selection.
  // It should return null/emailAddress:null when that account's Gmail web identity is unavailable.
  readonly readWebIdentity: (
    accountId: string,
    signal: AbortSignal
  ) => Promise<WebIdentitySnapshot | null>
  readonly identityTimeoutMs?: number
  readonly startAuthorization: (
    config: GoogleOAuthConfig,
    nonce?: string
  ) => GoogleAuthorizationOperation
  readonly prepareRelayChallenge?: (signal: AbortSignal) => Promise<string | undefined>
  readonly exchangeCode: (
    config: GoogleOAuthConfig,
    authorization: AuthorizationCode,
    signal: AbortSignal
  ) => Promise<GoogleOAuthTokens>
  readonly fetchProfile: (accessToken: string, signal: AbortSignal) => Promise<string>
  readonly reportProgress?: (
    stage: Exclude<OAuthDiagnosticStage, 'config' | 'connection' | 'persistence'>,
    outcome: OAuthDiagnosticOutcome,
    code?: OAuthDiagnosticCode
  ) => void
}

export interface GoogleConnectionOperation {
  readonly result: Promise<GoogleConnectionResult>
  cancel(): void
}

const activeByAccount = new Map<string, GoogleConnectionOperation>()

function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

function requestFailure(error: unknown, signal: AbortSignal): GoogleConnectionFailure {
  if (signal.aborted || readErrorCode(error) === 'cancelled') {
    return new GoogleConnectionFailure('cancelled')
  }
  const code = readErrorCode(error)
  if (
    code === 'timeout' ||
    code === 'network_error' ||
    code === 'redirect_refused' ||
    code === 'provider_error' ||
    code === 'invalid_response'
  ) {
    return new GoogleConnectionFailure(code)
  }
  return new GoogleConnectionFailure('network_error')
}

function authorizationFailure(error: unknown, signal: AbortSignal): GoogleConnectionFailure {
  if (signal.aborted || readErrorCode(error) === 'cancelled') {
    return new GoogleConnectionFailure('cancelled')
  }
  if (readErrorCode(error) === 'timeout') return new GoogleConnectionFailure('timeout')
  return new GoogleConnectionFailure('authorization_failed')
}

function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const email = value.trim()
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) return undefined
  return email.toLowerCase()
}

function waitForAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      operation.then(
        () => undefined,
        () => undefined
      )
      reject(new GoogleConnectionFailure('cancelled'))
      return
    }
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new GoogleConnectionFailure('cancelled'))
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

export function startGoogleConnection(
  accountId: string,
  config: GoogleOAuthConfig,
  dependencies: GoogleConnectionDependencies
): GoogleConnectionOperation {
  const controller = new AbortController()
  let authorization: GoogleAuthorizationOperation | undefined
  let settled = false
  let currentStage: Exclude<OAuthDiagnosticStage, 'config' | 'connection' | 'persistence'> | null =
    null
  let resolveResult: (value: GoogleConnectionResult) => void = () => undefined
  let rejectResult: (reason: GoogleConnectionFailure) => void = () => undefined
  const result = new Promise<GoogleConnectionResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // Keep setup failures handled until the caller attaches to result.
  void result.catch(() => undefined)

  const operation: GoogleConnectionOperation = {
    result,
    cancel: () => finish(new GoogleConnectionFailure('cancelled'))
  }

  const reportProgress = (
    stage: Exclude<OAuthDiagnosticStage, 'config' | 'connection' | 'persistence'>,
    outcome: OAuthDiagnosticOutcome,
    code?: OAuthDiagnosticCode
  ): void => {
    try {
      dependencies.reportProgress?.(stage, outcome, code)
    } catch {
      // Diagnostics must never affect authorization behavior.
    }
  }

  const beginStage = (
    stage: Exclude<OAuthDiagnosticStage, 'config' | 'connection' | 'persistence'>
  ): void => {
    currentStage = stage
    reportProgress(stage, 'started')
  }

  const finish = (error?: GoogleConnectionFailure, value?: GoogleConnectionResult): void => {
    if (settled) return
    settled = true
    if (activeByAccount.get(accountId) === operation) activeByAccount.delete(accountId)
    if (error) {
      if (currentStage) {
        reportProgress(
          currentStage,
          error.code === 'cancelled' ? 'cancelled' : 'failure',
          error.code
        )
        currentStage = null
      }
      controller.abort()
      try {
        authorization?.cancel()
      } catch {
        // A native authorization cancellation must not prevent the operation from settling.
      }
      rejectResult(error)
    } else if (value) {
      resolveResult(value)
    } else {
      rejectResult(new GoogleConnectionFailure('invalid_response'))
    }
  }

  const assertCurrent = (): void => {
    if (settled || activeByAccount.get(accountId) !== operation) {
      throw new GoogleConnectionFailure('cancelled')
    }
  }

  const getIdentity = async (): Promise<{ emailAddress: string; normalized: string }> => {
    let snapshot: WebIdentitySnapshot | null
    let timedOut = false
    const identityTimeout = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, dependencies.identityTimeoutMs ?? 10_000)
    try {
      snapshot = await waitForAbort(
        Promise.resolve().then(() => {
          assertCurrent()
          return dependencies.readWebIdentity(accountId, controller.signal)
        }),
        controller.signal
      )
    } catch {
      if (timedOut) throw new GoogleConnectionFailure('timeout')
      if (controller.signal.aborted) throw new GoogleConnectionFailure('cancelled')
      throw new GoogleConnectionFailure('identity_unavailable')
    } finally {
      clearTimeout(identityTimeout)
    }
    if (!snapshot || !snapshot.accountExists) throw new GoogleConnectionFailure('account_missing')
    const normalized = normalizeEmail(snapshot.emailAddress)
    if (!normalized || typeof snapshot.emailAddress !== 'string') {
      throw new GoogleConnectionFailure('identity_unavailable')
    }
    return { emailAddress: snapshot.emailAddress.trim(), normalized }
  }

  const run = async (): Promise<GoogleConnectionResult> => {
    if (!accountId.trim()) throw new GoogleConnectionFailure('account_missing')
    // OAuth starts without reading the Gmail page; the API profile names the account and is
    // matched against the page only after authorization.
    assertCurrent()

    let relayNonce: string | undefined
    if (dependencies.prepareRelayChallenge) {
      try {
        relayNonce = await waitForAbort(
          Promise.resolve().then(() => dependencies.prepareRelayChallenge?.(controller.signal)),
          controller.signal
        )
      } catch {
        if (controller.signal.aborted) throw new GoogleConnectionFailure('cancelled')
        relayNonce = undefined
      }
      assertCurrent()
    }

    beginStage('authorization')
    try {
      authorization = dependencies.startAuthorization(config, relayNonce)
    } catch {
      throw new GoogleConnectionFailure('authorization_failed')
    }
    let authorizationCode: AuthorizationCode
    try {
      authorizationCode = await waitForAbort(authorization.result, controller.signal)
    } catch (error) {
      throw authorizationFailure(error, controller.signal)
    }
    reportProgress('authorization', 'success')
    currentStage = null
    assertCurrent()

    let tokens: GoogleOAuthTokens
    beginStage('token_exchange')
    try {
      tokens = await waitForAbort(
        Promise.resolve().then(() => {
          assertCurrent()
          return dependencies.exchangeCode(config, authorizationCode, controller.signal)
        }),
        controller.signal
      )
    } catch (error) {
      throw requestFailure(error, controller.signal)
    }
    reportProgress('token_exchange', 'success')
    currentStage = null
    assertCurrent()

    let apiEmail: string
    beginStage('profile_fetch')
    try {
      apiEmail = await waitForAbort(
        Promise.resolve().then(() => {
          assertCurrent()
          return dependencies.fetchProfile(tokens.accessToken, controller.signal)
        }),
        controller.signal
      )
    } catch (error) {
      throw requestFailure(error, controller.signal)
    }
    assertCurrent()
    const normalizedApiEmail = normalizeEmail(apiEmail)
    if (!normalizedApiEmail) throw new GoogleConnectionFailure('invalid_response')
    reportProgress('profile_fetch', 'success')
    currentStage = null

    beginStage('identity_match')
    const webIdentity = await getIdentity()
    assertCurrent()
    if (normalizedApiEmail !== webIdentity.normalized) {
      throw new GoogleConnectionFailure('identity_mismatch')
    }
    reportProgress('identity_match', 'success')
    currentStage = null
    return { emailAddress: apiEmail.trim(), tokens, ...(relayNonce ? { relayNonce } : {}) }
  }

  activeByAccount.get(accountId)?.cancel()
  activeByAccount.set(accountId, operation)
  void Promise.resolve()
    .then(run)
    .then(
      (value) => {
        try {
          assertCurrent()
          finish(undefined, value)
        } catch (error) {
          if (error instanceof GoogleConnectionFailure) finish(error)
          else finish(new GoogleConnectionFailure('cancelled'))
        }
      },
      (error: unknown) => {
        if (error instanceof GoogleConnectionFailure) finish(error)
        else finish(requestFailure(error, controller.signal))
      }
    )

  return operation
}
