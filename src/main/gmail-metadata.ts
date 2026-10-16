export type GmailMetadataFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'redirect_refused'
  | 'unauthorized'
  | 'forbidden'
  | 'history_expired'
  | 'rate_limited'
  | 'provider_error'
  | 'invalid_response'

export class GmailMetadataFailure extends Error {
  constructor(readonly code: GmailMetadataFailureCode) {
    super(`Gmail metadata ${code.replaceAll('_', ' ')}`)
    this.name = 'GmailMetadataFailure'
  }
}

export interface GmailMetadataOptions {
  readonly fetch: typeof fetch
  readonly signal: AbortSignal
  readonly timeoutMs?: number
}

export interface GmailWatchOptions extends GmailMetadataOptions {
  readonly now: () => number
}

export interface GmailWatchResult {
  readonly historyId: string
  readonly expiresAt: number
}

export interface GmailHistoryPage {
  readonly historyId: string
  readonly addedMessageIds: readonly string[]
  readonly nextPageToken?: string
}

const GMAIL_API_ORIGIN = 'https://gmail.googleapis.com'
const DEFAULT_TIMEOUT_MS = 15_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateToken(accessToken: string): void {
  if (
    typeof accessToken !== 'string' ||
    accessToken.trim().length === 0 ||
    /[\r\n]/.test(accessToken)
  ) {
    throw new GmailMetadataFailure('invalid_response')
  }
}

function validateHistoryId(historyId: unknown): string {
  if (typeof historyId !== 'string' || !/^[1-9]\d*$/.test(historyId)) {
    throw new GmailMetadataFailure('invalid_response')
  }
  return historyId
}

function validateOptions(options: GmailMetadataOptions): number {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new GmailMetadataFailure('invalid_response')
  }
  if (options.signal.aborted) throw new GmailMetadataFailure('cancelled')
  return timeoutMs
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      operation.then(
        () => undefined,
        () => undefined
      )
      reject(new GmailMetadataFailure('cancelled'))
      return
    }
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new GmailMetadataFailure('cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      () => {
        signal.removeEventListener('abort', onAbort)
        reject(new GmailMetadataFailure('network_error'))
      }
    )
  })
}

async function requestJson(
  url: string,
  accessToken: string,
  options: GmailMetadataOptions,
  notFoundCode: GmailMetadataFailureCode = 'provider_error',
  request?: { readonly method: 'POST'; readonly body?: string; readonly allowNoContent?: boolean }
): Promise<unknown> {
  validateToken(accessToken)
  const timeoutMs = validateOptions(options)
  const controller = new AbortController()
  let timedOut = false
  const relayAbort = (): void => controller.abort()
  options.signal.addEventListener('abort', relayAbort, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const init: RequestInit = {
      method: request?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(request?.body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      redirect: 'error',
      signal: controller.signal,
      ...(request?.body === undefined ? {} : { body: request.body })
    }
    const response = await raceAbort(options.fetch(url, init), controller.signal)
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      throw new GmailMetadataFailure('redirect_refused')
    }
    if (!response.ok) {
      const code =
        response.status === 401
          ? 'unauthorized'
          : response.status === 403
            ? 'forbidden'
            : response.status === 404
              ? notFoundCode
              : response.status === 429
                ? 'rate_limited'
                : 'provider_error'
      throw new GmailMetadataFailure(code)
    }
    if (request?.allowNoContent === true && response.status === 204) return {}
    try {
      return await raceAbort(response.json(), controller.signal)
    } catch {
      if (timedOut) throw new GmailMetadataFailure('timeout')
      if (options.signal.aborted) throw new GmailMetadataFailure('cancelled')
      throw new GmailMetadataFailure('invalid_response')
    }
  } catch (error) {
    if (timedOut) throw new GmailMetadataFailure('timeout')
    if (options.signal.aborted) throw new GmailMetadataFailure('cancelled')
    if (error instanceof GmailMetadataFailure) throw error
    throw new GmailMetadataFailure('network_error')
  } finally {
    clearTimeout(timeout)
    options.signal.removeEventListener('abort', relayAbort)
  }
}

function readWatchNow(now: () => number): number {
  try {
    const value = now()
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid clock')
    return value
  } catch {
    throw new GmailMetadataFailure('invalid_response')
  }
}

function getWatchClock(options: GmailWatchOptions): () => number {
  try {
    if (typeof options.now !== 'function') throw new Error('invalid clock')
    return options.now
  } catch {
    throw new GmailMetadataFailure('invalid_response')
  }
}

export async function registerGmailWatch(
  accessToken: string,
  topicName: string,
  options: GmailWatchOptions
): Promise<GmailWatchResult> {
  if (
    typeof topicName !== 'string' ||
    !/^projects\/[A-Za-z0-9_-]+\/topics\/[A-Za-z0-9._~+%-]+$/.test(topicName)
  ) {
    throw new GmailMetadataFailure('invalid_response')
  }
  const now = getWatchClock(options)
  readWatchNow(now)
  const payload = await requestJson(
    `${GMAIL_API_ORIGIN}/gmail/v1/users/me/watch?fields=historyId%2Cexpiration`,
    accessToken,
    options,
    'provider_error',
    { method: 'POST', body: JSON.stringify({ topicName }) }
  )
  if (!isRecord(payload)) throw new GmailMetadataFailure('invalid_response')
  const historyId = validateHistoryId(payload.historyId)
  if (typeof payload.expiration !== 'string' || !/^[1-9]\d*$/.test(payload.expiration)) {
    throw new GmailMetadataFailure('invalid_response')
  }
  const expiresAt = Number(payload.expiration)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0 || expiresAt <= readWatchNow(now)) {
    throw new GmailMetadataFailure('invalid_response')
  }
  return { historyId, expiresAt }
}

export async function stopGmailWatch(
  accessToken: string,
  options: GmailMetadataOptions
): Promise<void> {
  const payload = await requestJson(
    `${GMAIL_API_ORIGIN}/gmail/v1/users/me/stop`,
    accessToken,
    options,
    'provider_error',
    { method: 'POST', allowNoContent: true }
  )
  if (!isRecord(payload) || Object.keys(payload).length !== 0) {
    throw new GmailMetadataFailure('invalid_response')
  }
}

export async function fetchGmailUnreadCount(
  accessToken: string,
  labelId: 'INBOX' | 'UNREAD',
  options: GmailMetadataOptions
): Promise<number> {
  if (labelId !== 'INBOX' && labelId !== 'UNREAD') {
    throw new GmailMetadataFailure('invalid_response')
  }
  const url = `${GMAIL_API_ORIGIN}/gmail/v1/users/me/labels/${labelId}?fields=id%2CmessagesUnread`
  const payload = await requestJson(url, accessToken, options)
  if (
    !isRecord(payload) ||
    payload.id !== labelId ||
    typeof payload.messagesUnread !== 'number' ||
    !Number.isSafeInteger(payload.messagesUnread) ||
    payload.messagesUnread < 0
  ) {
    throw new GmailMetadataFailure('invalid_response')
  }
  return payload.messagesUnread
}

export async function fetchGmailHistoryId(
  accessToken: string,
  options: GmailMetadataOptions
): Promise<string> {
  const payload = await requestJson(
    `${GMAIL_API_ORIGIN}/gmail/v1/users/me/profile?fields=historyId`,
    accessToken,
    options
  )
  if (!isRecord(payload)) throw new GmailMetadataFailure('invalid_response')
  return validateHistoryId(payload.historyId)
}

export async function fetchGmailHistoryPage(
  accessToken: string,
  startHistoryId: string,
  pageToken: string | undefined,
  options: GmailMetadataOptions
): Promise<GmailHistoryPage> {
  validateHistoryId(startHistoryId)
  if (
    pageToken !== undefined &&
    (typeof pageToken !== 'string' || pageToken.trim().length === 0 || /[\r\n]/.test(pageToken))
  ) {
    throw new GmailMetadataFailure('invalid_response')
  }
  const url = new URL('/gmail/v1/users/me/history', GMAIL_API_ORIGIN)
  url.searchParams.set('startHistoryId', startHistoryId)
  url.searchParams.set('historyTypes', 'messageAdded')
  url.searchParams.set('fields', 'historyId,nextPageToken,history(messagesAdded(message(id)))')
  if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken)
  const payload = await requestJson(url.toString(), accessToken, options, 'history_expired')
  if (!isRecord(payload)) throw new GmailMetadataFailure('invalid_response')
  const historyId = validateHistoryId(payload.historyId)
  if (
    payload.nextPageToken !== undefined &&
    (typeof payload.nextPageToken !== 'string' ||
      payload.nextPageToken.trim().length === 0 ||
      /[\r\n]/.test(payload.nextPageToken))
  ) {
    throw new GmailMetadataFailure('invalid_response')
  }
  const addedMessageIds = new Set<string>()
  if (payload.history !== undefined) {
    if (!Array.isArray(payload.history)) throw new GmailMetadataFailure('invalid_response')
    for (const entry of payload.history) {
      if (!isRecord(entry)) throw new GmailMetadataFailure('invalid_response')
      if (entry.messagesAdded === undefined) continue
      if (!Array.isArray(entry.messagesAdded)) throw new GmailMetadataFailure('invalid_response')
      for (const added of entry.messagesAdded) {
        if (
          !isRecord(added) ||
          !isRecord(added.message) ||
          typeof added.message.id !== 'string' ||
          !added.message.id
        ) {
          throw new GmailMetadataFailure('invalid_response')
        }
        addedMessageIds.add(added.message.id)
      }
    }
  }
  return {
    historyId,
    addedMessageIds: [...addedMessageIds],
    ...(payload.nextPageToken === undefined ? {} : { nextPageToken: payload.nextPageToken })
  }
}
