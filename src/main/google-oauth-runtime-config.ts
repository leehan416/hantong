import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import {
  GOOGLE_CLIENT_ID_ENV,
  GOOGLE_CLIENT_SECRET_ENV,
  loadGoogleOAuthConfig
} from './google-oauth-config'
import type { GoogleOAuthConfig } from './google-oauth-config'

interface RuntimeConfigOptions {
  readonly environment: Record<string, string | undefined>
  readonly isPackaged: boolean
  readonly localEnvPath?: string
  // Build-time values; used only by packaged builds when the launcher supplies neither key.
  readonly bundled?: Record<string, string | undefined>
}

interface RuntimeConfigIO {
  readonly readFile?: typeof readFileSync
  readonly parseEnv?: typeof parseEnv
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function hasLauncherConfig(environment: Record<string, string | undefined>): boolean {
  return (
    environment[GOOGLE_CLIENT_ID_ENV] !== undefined ||
    environment[GOOGLE_CLIENT_SECRET_ENV] !== undefined
  )
}

export function loadRuntimeGoogleOAuthConfig(
  options: RuntimeConfigOptions,
  io: RuntimeConfigIO = {}
): GoogleOAuthConfig {
  const { environment, isPackaged, localEnvPath, bundled } = options
  if (hasLauncherConfig(environment)) return loadGoogleOAuthConfig(environment)

  if (!isPackaged && localEnvPath) {
    let source: string
    try {
      source = (io.readFile ?? readFileSync)(localEnvPath, 'utf8')
    } catch (error) {
      if (isMissingFile(error)) return loadGoogleOAuthConfig({})
      // Read errors can expose the local path, so do not retain them as a cause.
      // eslint-disable-next-line preserve-caught-error -- The raw read error may disclose the local path.
      throw new Error('Unable to load local Google OAuth configuration')
    }

    let parsed: ReturnType<typeof parseEnv>
    try {
      parsed = (io.parseEnv ?? parseEnv)(source)
    } catch {
      // Parser errors can include local config contents, so never retain them as a cause.
      throw new Error('Unable to load local Google OAuth configuration')
    }

    return loadGoogleOAuthConfig({
      [GOOGLE_CLIENT_ID_ENV]: parsed[GOOGLE_CLIENT_ID_ENV],
      [GOOGLE_CLIENT_SECRET_ENV]: parsed[GOOGLE_CLIENT_SECRET_ENV]
    })
  }

  return loadGoogleOAuthConfig(isPackaged && bundled ? bundled : {})
}
