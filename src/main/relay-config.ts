import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

export interface RelayConfig {
  readonly baseUrl: string
}

interface RelayConfigOptions {
  readonly environment: Record<string, string | undefined>
  readonly isPackaged: boolean
  readonly localEnvPath?: string
}

interface RelayConfigIO {
  readonly readFile?: typeof readFileSync
  readonly parseEnv?: typeof parseEnv
}

// The relay server mounts every route under /api/v1; a bare origin gets the prefix appended.
const API_PREFIX = '/api/v1/'
const API_PATHS = new Set(['', '/', '/api/v1', API_PREFIX])

function validBaseUrl(value: string | undefined, isPackaged: boolean): RelayConfig | undefined {
  if (!value?.trim()) return undefined
  const trimmed = value.trim()
  if (trimmed.includes('\\')) throw new Error('Relay configuration is invalid')
  const rawPath = /^https?:\/\/[^/?#]*(\/[^?#]*)?/i.exec(trimmed)?.[1] ?? ''
  if (!API_PATHS.has(rawPath)) {
    throw new Error('Relay configuration is invalid')
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error('Relay configuration is invalid')
  }
  const localHttp =
    !isPackaged &&
    url.protocol === 'http:' &&
    /^http:\/\/127\.0\.0\.1(?::[0-9]{1,5})?(?:\/|\/api\/v1\/?)?$/i.test(trimmed)
  if (
    (url.protocol !== 'https:' && !localHttp) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !API_PATHS.has(url.pathname)
  )
    throw new Error('Relay configuration is invalid')
  return { baseUrl: `${url.origin}${API_PREFIX}` }
}

export function loadRuntimeRelayConfig(
  options: RelayConfigOptions,
  io: RelayConfigIO = {}
): RelayConfig | undefined {
  const launcherValue = options.environment.HANTONG_RELAY_URL
  if (launcherValue !== undefined) return validBaseUrl(launcherValue, options.isPackaged)
  if (options.isPackaged || !options.localEnvPath) return undefined
  let source: string
  let readFailed = false
  try {
    source = (io.readFile ?? readFileSync)(options.localEnvPath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }
    readFailed = true
    source = ''
  }
  if (readFailed) throw new Error('Relay configuration is unavailable')
  let parsed: Record<string, string | undefined>
  try {
    parsed = (io.parseEnv ?? parseEnv)(source)
  } catch {
    throw new Error('Relay configuration is invalid')
  }
  return validBaseUrl(parsed.HANTONG_RELAY_URL, false)
}
