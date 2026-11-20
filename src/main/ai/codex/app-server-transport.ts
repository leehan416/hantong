import type { ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'

const MAX_PROTOCOL_LINE_BYTES = 256_000

type RpcResponse = {
  result?: unknown
  error?: { message?: string; data?: { type?: string; codexErrorInfo?: string } }
}
type PendingRpc = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class AppServerRpcError extends Error {
  readonly category: string | undefined

  constructor(message: string, category: string | undefined) {
    super(message)
    this.category = category
  }
}

export type AppServerTransport = {
  closed: boolean
  failPending: (reason: string) => void
  markClosed: () => void
  request: (method: string, params?: unknown) => Promise<unknown>
}

export function createAppServerTransport(
  child: ChildProcess,
  requestTimeoutMs: number,
  onNotification: (packet: Record<string, unknown>) => void,
  onInvalidProtocol: (fatal: boolean) => void
): AppServerTransport {
  const pending = new Map<string, PendingRpc>()
  let sequence = 1
  let stdoutBuffer = Buffer.alloc(0)
  let closed = false

  const failPending = (reason: string): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error(reason))
    }
    pending.clear()
  }

  const respondToUnsupportedRequest = (packet: Record<string, unknown>): void => {
    const input = child.stdin
    if (!input) {
      failPending('app_server_input_unavailable')
      return
    }
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: packet['id'], error: { code: -32601, message: 'Unsupported request' } })}\n`
    )
  }

  const receiveLine = (line: string): void => {
    if (closed) return
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      failPending('invalid_protocol')
      onInvalidProtocol(true)
      return
    }
    let packet: Record<string, unknown>
    try {
      packet = JSON.parse(line) as Record<string, unknown>
    } catch {
      failPending('invalid_protocol')
      onInvalidProtocol(false)
      return
    }
    if (typeof packet['method'] === 'string' && packet['id'] !== undefined) {
      respondToUnsupportedRequest(packet)
      return
    }
    const id = packet['id']
    if (id !== undefined) {
      const response = packet as RpcResponse
      const request = pending.get(String(id))
      if (!request) return
      clearTimeout(request.timer)
      pending.delete(String(id))
      if (response.error) {
        const detail = response.error.data?.type ?? response.error.data?.codexErrorInfo ?? ''
        request.reject(new AppServerRpcError(response.error.message ?? '', detail))
      } else request.resolve(response.result)
      return
    }
    if (
      typeof packet['method'] === 'string' &&
      packet['params'] &&
      typeof packet['params'] === 'object'
    )
      onNotification(packet)
  }

  child.stdout?.on('data', (chunk: Buffer | string) => {
    if (closed) return
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length > MAX_PROTOCOL_LINE_BYTES) {
      stdoutBuffer = Buffer.alloc(0)
      failPending('invalid_protocol')
      onInvalidProtocol(true)
      return
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, incoming])
    let newline: number
    while ((newline = stdoutBuffer.indexOf(0x0a)) >= 0) {
      const line = stdoutBuffer.subarray(0, newline)
      stdoutBuffer = stdoutBuffer.subarray(newline + 1)
      if (line.length > MAX_PROTOCOL_LINE_BYTES) {
        stdoutBuffer = Buffer.alloc(0)
        failPending('invalid_protocol')
        onInvalidProtocol(true)
        return
      }
      receiveLine(line.toString('utf8'))
    }
    if (stdoutBuffer.length > MAX_PROTOCOL_LINE_BYTES) {
      stdoutBuffer = Buffer.alloc(0)
      failPending('invalid_protocol')
      onInvalidProtocol(true)
    }
  })

  return {
    get closed() {
      return closed
    },
    failPending,
    markClosed: () => {
      closed = true
      stdoutBuffer = Buffer.alloc(0)
    },
    request: (method, params = {}) => {
      if (closed) return Promise.reject(new Error('app_server_closed'))
      const input = child.stdin
      if (!input) return Promise.reject(new Error('app_server_input_unavailable'))
      const id = String(sequence++)
      const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          rejectPromise(new Error('app_server_timeout'))
        }, requestTimeoutMs)
        pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      })
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      return promise
    }
  }
}
