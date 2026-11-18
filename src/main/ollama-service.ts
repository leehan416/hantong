import type { OllamaConnectionStatus, OllamaModel } from '../shared/ipc'

const ORIGIN = 'http://127.0.0.1:11434'
const REQUEST_TIMEOUT_MS = 3000
const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_MODELS = 256
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/

type FetchLike = typeof fetch

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasRemoteRoute(value: Record<string, unknown>): boolean {
  return value.remote_host !== undefined || value.remote_model !== undefined
}

function isCloudAlias(model: string): boolean {
  return /(?:^|[:_-])cloud$/i.test(model)
}

export function createOllamaService(options: { fetch?: FetchLike; timeoutMs?: number } = {}): {
  getStatus(): Promise<OllamaConnectionStatus>
  getModels(): Promise<OllamaModel[]>
  validateModel(name: string): Promise<void>
  dispose(): void
} {
  const fetcher = options.fetch ?? fetch
  const controllers = new Set<AbortController>()
  let disposed = false

  async function request(
    path: '/api/status' | '/api/tags' | '/api/show',
    body?: object
  ): Promise<unknown> {
    if (disposed) throw new Error('Ollama service disposed')
    const controller = new AbortController()
    controllers.add(controller)
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? REQUEST_TIMEOUT_MS)
    try {
      const response = await fetcher(`${ORIGIN}${path}`, {
        method: body ? 'POST' : 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (response.status < 200 || response.status >= 300) throw new Error('Ollama request failed')
      const contentLength = response.headers.get('content-length')
      if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES)
        throw new Error('Ollama response too large')
      if (!response.body) throw new Error('Ollama response missing body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error('Ollama response too large')
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
    } finally {
      clearTimeout(timeout)
      controllers.delete(controller)
    }
  }

  async function cloudDisabled(): Promise<boolean> {
    const value = await request('/api/status')
    return isRecord(value) && isRecord(value.cloud) && value.cloud.disabled === true
  }

  async function getStatus(): Promise<OllamaConnectionStatus> {
    try {
      if (!(await cloudDisabled())) return { state: 'unavailable', cloudDisabled: false }
      return { state: 'available', cloudDisabled: true }
    } catch {
      return { state: 'unavailable', cloudDisabled: false }
    }
  }

  async function getModels(): Promise<OllamaModel[]> {
    try {
      if (!(await cloudDisabled())) return []
      const value = await request('/api/tags')
      if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > MAX_MODELS)
        return []
      return value.models.flatMap((item): OllamaModel[] => {
        if (!isRecord(item) || typeof item.name !== 'string' || !MODEL_NAME.test(item.name))
          return []
        const canonical = typeof item.model === 'string' ? item.model : item.name
        if (
          canonical.length > 256 ||
          hasRemoteRoute(item) ||
          isCloudAlias(item.name) ||
          isCloudAlias(canonical)
        )
          return []
        return [
          {
            name: item.name,
            size:
              typeof item.size === 'number' && Number.isSafeInteger(item.size) && item.size >= 0
                ? item.size
                : null
          }
        ]
      })
    } catch {
      return []
    }
  }

  async function validateModel(name: string): Promise<void> {
    if (!MODEL_NAME.test(name)) throw new Error('Invalid Ollama model')
    const models = await getModels()
    if (!models.some((model) => model.name === name))
      throw new Error('Ollama model is not available as a local model')
    const shown = await request('/api/show', { model: name })
    if (!isRecord(shown) || hasRemoteRoute(shown))
      throw new Error('Ollama model is not available as a local model')
  }

  return {
    getStatus,
    getModels,
    validateModel,
    dispose: () => {
      disposed = true
      for (const controller of controllers) controller.abort()
      controllers.clear()
    }
  }
}
