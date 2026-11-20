import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { normalizeRemoteOllamaEndpoint } from './ai-provider-policy'

export interface OllamaSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<string | { result: string; shouldReEncrypt: boolean }>
}

export function createOllamaCredentialStore(options: {
  directory: string
  safeStorage: OllamaSafeStorage
}): {
  has(endpoint: string): Promise<boolean>
  get(endpoint: string): Promise<string | null>
  set(endpoint: string, value: string, beforeCommit?: () => void): Promise<void>
  clear(endpoint: string, beforeCommit?: () => void): Promise<void>
} {
  const operations = new Map<string, Promise<void>>()

  function fileFor(endpoint: string): { endpoint: string; file: string } {
    const normalized = normalizeRemoteOllamaEndpoint(endpoint)
    const digest = createHash('sha256').update(normalized).digest('hex')
    return { endpoint: normalized, file: join(options.directory, `ollama-api-key-${digest}.enc`) }
  }

  function serialize<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const result = (operations.get(file) ?? Promise.resolve()).then(operation)
    const queued = result.then(
      () => undefined,
      () => undefined
    )
    operations.set(file, queued)
    void queued.then(() => {
      if (operations.get(file) === queued) operations.delete(file)
    })
    return result
  }

  async function get(endpoint: string): Promise<string | null> {
    const binding = fileFor(endpoint)
    let encrypted: Buffer
    try {
      encrypted = await readFile(binding.file)
    } catch {
      return null
    }
    if (!(await options.safeStorage.isAsyncEncryptionAvailable())) return null
    try {
      const decrypted = await options.safeStorage.decryptStringAsync(encrypted)
      const value = typeof decrypted === 'string' ? decrypted : decrypted.result
      const stored = JSON.parse(value) as { endpoint?: unknown; credential?: unknown }
      return stored.endpoint === binding.endpoint &&
        typeof stored.credential === 'string' &&
        /^[\x21-\x7e]{1,4096}$/.test(stored.credential)
        ? stored.credential
        : null
    } catch {
      return null
    }
  }

  return {
    has: async (endpoint) => (await get(endpoint)) !== null,
    get,
    async set(endpoint: string, value: string, beforeCommit?: () => void): Promise<void> {
      if (!/^[\x21-\x7e]{1,4096}$/.test(value)) throw new Error('Invalid credential')
      const binding = fileFor(endpoint)
      return serialize(binding.file, async () => {
        if (!(await options.safeStorage.isAsyncEncryptionAvailable()))
          throw new Error('Protected storage unavailable')
        await mkdir(options.directory, { recursive: true, mode: 0o700 })
        const temporary = join(options.directory, `.ollama-key-${randomUUID()}.tmp`)
        try {
          const encrypted = await options.safeStorage.encryptStringAsync(
            JSON.stringify({ endpoint: binding.endpoint, credential: value })
          )
          await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
          beforeCommit?.()
          await rename(temporary, binding.file)
        } catch {
          await rm(temporary, { force: true }).catch(() => undefined)
          throw new Error('Unable to save protected credential')
        }
      })
    },
    async clear(endpoint, beforeCommit): Promise<void> {
      const binding = fileFor(endpoint)
      return serialize(binding.file, async () => {
        beforeCommit?.()
        await rm(binding.file, { force: true })
      })
    }
  }
}
