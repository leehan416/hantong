export type RelayFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'redirect_refused'

export class RelayFailure extends Error {
  constructor(readonly code: RelayFailureCode) {
    super(`Hantong relay ${code.replaceAll('_', ' ')}`)
    this.name = 'RelayFailure'
  }
}

export interface RelaySignal {
  readonly type: 'ready' | 'mailbox_changed'
  readonly resync?: true
  readonly historyId?: string
}

interface RelayResponse {
  readonly status: number
  readonly ok: boolean
  readonly redirected: boolean
  readonly headers: { get(name: string): string | null }
  json(): Promise<unknown>
  readonly body?: ReadableStream<Uint8Array> | null
}

interface RelayClientOptions {
  readonly baseUrl: string
  readonly fetch: typeof fetch
  readonly now: () => number
  readonly timeoutMs?: number
  readonly streamIdleMs?: number
}

interface Challenge {
  readonly nonce: string
}

interface RelaySession {
  readonly accessToken: string
  readonly expiresAt: number
}

const SAFE_OPAQUE = /^[A-Za-z0-9._~-]{1,2048}$/
const MAX_EVENT_BUFFER = 64 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      promise.catch(() => undefined)
      reject(new RelayFailure('cancelled'))
      return
    }
    const abort = (): void => reject(new RelayFailure('cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function parseSignal(event: string, data: string): RelaySignal | undefined {
  if (event !== 'ready' && event !== 'mailbox_changed') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    throw new RelayFailure('invalid_response')
  }
  if (!record(parsed)) throw new RelayFailure('invalid_response')
  if (event === 'ready' && parsed.resync === true) return { type: 'ready', resync: true }
  if (
    event === 'mailbox_changed' &&
    typeof parsed.historyId === 'string' &&
    /^[1-9][0-9]{0,39}$/.test(parsed.historyId)
  ) {
    return { type: 'mailbox_changed', historyId: parsed.historyId }
  }
  throw new RelayFailure('invalid_response')
}

async function readBoundedJson(response: RelayResponse, signal: AbortSignal): Promise<unknown> {
  if (!response.body) return raceAbort(response.json(), signal)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await raceAbort(reader.read(), signal)
      } catch (error) {
        if (error instanceof RelayFailure) throw error
        throw new RelayFailure('network_error')
      }
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > MAX_EVENT_BUFFER) throw new RelayFailure('invalid_response')
      chunks.push(chunk.value)
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    throw new RelayFailure('invalid_response')
  }
}

export function createRelayClient(options: RelayClientOptions): {
  fetchChallenge(signal?: AbortSignal): Promise<Challenge>
  createSession(
    idToken: string,
    nonce: string,
    installationId: string,
    signal?: AbortSignal
  ): Promise<RelaySession>
  deleteSession(token: string): Promise<void>
  consumeEvents(
    token: string,
    onEvent: (event: RelaySignal) => void,
    signal?: AbortSignal
  ): Promise<void>
} {
  const timeoutMs = options.timeoutMs ?? 15_000
  const request = async (
    path: string,
    init: RequestInit,
    externalSignal?: AbortSignal
  ): Promise<{
    response: RelayResponse
    controller: AbortController
    stopTimeout: () => void
    done: () => void
    timedOut: () => boolean
  }> => {
    const controller = new AbortController()
    let timedOut = false
    const abort = (): void => controller.abort()
    if (externalSignal?.aborted) throw new RelayFailure('cancelled')
    externalSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const stopTimeout = (): void => clearTimeout(timer)
    const done = (): void => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abort)
    }
    try {
      const response = (await raceAbort(
        options.fetch(new URL(path, `${options.baseUrl}/`).href, {
          ...init,
          redirect: 'error',
          signal: controller.signal
        }),
        controller.signal
      )) as RelayResponse
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        void response.body?.cancel().catch(() => undefined)
        throw new RelayFailure('redirect_refused')
      }
      return { response, controller, stopTimeout, done, timedOut: () => timedOut }
    } catch (error) {
      done()
      if (timedOut) throw new RelayFailure('timeout')
      if (externalSignal?.aborted) throw new RelayFailure('cancelled')
      if (error instanceof RelayFailure) throw error
      throw new RelayFailure('network_error')
    }
  }
  const readJson = async (
    path: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<unknown> => {
    const { response, controller, done, timedOut } = await request(path, init, signal)
    try {
      if (
        response.status === 401 ||
        response.status === 429 ||
        response.status >= 500 ||
        !response.ok
      ) {
        controller.abort()
        void response.body?.cancel().catch(() => undefined)
        if (response.status === 401) throw new RelayFailure('unauthorized')
        if (response.status === 429) throw new RelayFailure('rate_limited')
        if (response.status >= 500) throw new RelayFailure('unavailable')
        throw new RelayFailure('invalid_response')
      }
      try {
        return await readBoundedJson(response, controller.signal)
      } catch (error) {
        if (timedOut()) throw new RelayFailure('timeout')
        if (error instanceof RelayFailure) throw error
        throw new RelayFailure('invalid_response')
      }
    } finally {
      done()
    }
  }

  return {
    async fetchChallenge(signal): Promise<Challenge> {
      const payload = await readJson('/auth/challenge', { method: 'POST' }, signal)
      if (
        !record(payload) ||
        typeof payload.nonce !== 'string' ||
        !SAFE_OPAQUE.test(payload.nonce) ||
        typeof payload.expires_in !== 'number' ||
        !Number.isSafeInteger(payload.expires_in) ||
        payload.expires_in < 1 ||
        payload.expires_in > 300
      )
        throw new RelayFailure('invalid_response')
      return { nonce: payload.nonce }
    },
    async createSession(idToken, nonce, installationId, signal): Promise<RelaySession> {
      if (!idToken.trim() || !SAFE_OPAQUE.test(nonce) || !installationId.trim()) {
        throw new RelayFailure('invalid_response')
      }
      const payload = await readJson(
        '/auth/session',
        {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ id_token: idToken, nonce, installation_id: installationId })
        },
        signal
      )
      if (
        !record(payload) ||
        typeof payload.access_token !== 'string' ||
        !SAFE_OPAQUE.test(payload.access_token) ||
        payload.token_type !== 'Bearer' ||
        typeof payload.expires_in !== 'number' ||
        !Number.isSafeInteger(payload.expires_in) ||
        payload.expires_in < 1 ||
        payload.expires_in > 3600
      )
        throw new RelayFailure('invalid_response')
      const expiresAt = options.now() + payload.expires_in * 1000
      if (!Number.isSafeInteger(expiresAt)) throw new RelayFailure('invalid_response')
      return { accessToken: payload.access_token, expiresAt }
    },
    async deleteSession(token): Promise<void> {
      const { response, controller, done } = await request('/auth/session', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` }
      })
      try {
        if (response.status === 401 || !response.ok || response.status !== 204) {
          controller.abort()
          void response.body?.cancel().catch(() => undefined)
          if (response.status === 401) throw new RelayFailure('unauthorized')
          throw new RelayFailure('unavailable')
        }
      } finally {
        done()
      }
    },
    async consumeEvents(token, onEvent, signal): Promise<void> {
      const { response, controller, stopTimeout, done } = await request(
        '/events',
        {
          method: 'GET',
          headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` }
        },
        signal
      )
      const idleMs = options.streamIdleMs ?? 45_000
      let idle: ReturnType<typeof setTimeout> | undefined
      const resetIdle = (): void => {
        if (idle) clearTimeout(idle)
        idle = setTimeout(() => controller.abort(), idleMs)
      }
      try {
        stopTimeout()
        if (
          response.status === 401 ||
          response.status === 429 ||
          response.status >= 500 ||
          !response.ok
        ) {
          controller.abort()
          void response.body?.cancel().catch(() => undefined)
          if (response.status === 401) throw new RelayFailure('unauthorized')
          if (response.status === 429) throw new RelayFailure('rate_limited')
          if (response.status >= 500) throw new RelayFailure('unavailable')
          throw new RelayFailure('invalid_response')
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
          controller.abort()
          void response.body?.cancel().catch(() => undefined)
          throw new RelayFailure('invalid_response')
        }
        if (!response.body) throw new RelayFailure('invalid_response')
        const reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let buffer = ''
        let event = ''
        let data: string[] = []
        let dataSize = 0
        const dispatch = (): void => {
          if (data.length) {
            const parsed = parseSignal(event, data.join('\n'))
            if (parsed) onEvent(parsed)
          }
          event = ''
          data = []
          dataSize = 0
        }
        resetIdle()
        try {
          while (true) {
            let chunk: ReadableStreamReadResult<Uint8Array>
            try {
              chunk = await raceAbort(reader.read(), controller.signal)
            } catch {
              if (controller.signal.aborted) {
                throw new RelayFailure(signal?.aborted ? 'cancelled' : 'timeout')
              }
              throw new RelayFailure('network_error')
            }
            if (chunk.done) break
            resetIdle()
            buffer += decoder.decode(chunk.value, { stream: true })
            if (buffer.length + dataSize > MAX_EVENT_BUFFER) {
              throw new RelayFailure('invalid_response')
            }
            let index: number
            while ((index = buffer.indexOf('\n')) >= 0) {
              let line = buffer.slice(0, index)
              buffer = buffer.slice(index + 1)
              if (line.endsWith('\r')) line = line.slice(0, -1)
              if (!line) dispatch()
              else if (!line.startsWith(':')) {
                const colon = line.indexOf(':')
                const field = colon < 0 ? line : line.slice(0, colon)
                const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
                if (field === 'event') event = value
                else if (field === 'data') {
                  data.push(value)
                  dataSize += value.length + 1
                  if (buffer.length + dataSize > MAX_EVENT_BUFFER) {
                    throw new RelayFailure('invalid_response')
                  }
                }
              }
            }
          }
          buffer += decoder.decode()
          if (buffer.length) throw new RelayFailure('invalid_response')
          dispatch()
        } catch (error) {
          void reader.cancel().catch(() => undefined)
          if (controller.signal.aborted)
            throw new RelayFailure(signal?.aborted ? 'cancelled' : 'timeout')
          if (error instanceof RelayFailure) throw error
          throw new RelayFailure('invalid_response')
        } finally {
          reader.releaseLock()
        }
      } finally {
        if (idle) clearTimeout(idle)
        done()
      }
    }
  }
}
