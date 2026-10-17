import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAccountId } from './account-state'
import type { GoogleSafeStorage } from './google-credential-store'

export interface RelayCredentialStoreOptions {
  readonly directory: string
  readonly platform: NodeJS.Platform
  readonly safeStorage: GoogleSafeStorage
}

const SAFE_OPAQUE = /^[A-Za-z0-9._~-]{1,2048}$/

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

// Holds only the relay refresh token per account, encrypted with the OS keychain-backed safeStorage.
export function createRelayCredentialStore(options: RelayCredentialStoreOptions): {
  read(accountId: string): Promise<string | null>
  write(accountId: string, refreshToken: string): Promise<void>
  delete(accountId: string): Promise<void>
} {
  const pathFor = (accountId: string): string => {
    if (!isAccountId(accountId)) throw new Error('Relay credentials are unavailable')
    return join(options.directory, `${accountId}.credential`)
  }
  const ensureAvailable = async (): Promise<void> => {
    if (
      options.platform !== 'darwin' ||
      (await options.safeStorage.isAsyncEncryptionAvailable()) !== true
    ) {
      throw new Error('Relay credentials are unavailable')
    }
  }

  return {
    async read(accountId): Promise<string | null> {
      const path = pathFor(accountId)
      await ensureAvailable()
      let encoded: string
      try {
        encoded = await readFile(path, 'utf8')
      } catch (error) {
        if (isMissing(error)) return null
        // Filesystem errors can expose local paths; keep failures generic.
        // eslint-disable-next-line preserve-caught-error
        throw new Error('Relay credentials are unavailable')
      }
      try {
        const decrypted = await options.safeStorage.decryptStringAsync(
          Buffer.from(encoded, 'base64')
        )
        const value: unknown = JSON.parse(decrypted.result)
        if (
          typeof value !== 'object' ||
          value === null ||
          !('accountId' in value) ||
          value.accountId !== accountId ||
          !('refreshToken' in value) ||
          typeof value.refreshToken !== 'string' ||
          !SAFE_OPAQUE.test(value.refreshToken)
        ) {
          throw new Error('Invalid record')
        }
        return value.refreshToken
      } catch {
        throw new Error('Relay credentials are unavailable')
      }
    },
    async write(accountId, refreshToken): Promise<void> {
      const path = pathFor(accountId)
      if (!SAFE_OPAQUE.test(refreshToken)) throw new Error('Relay credentials are unavailable')
      await ensureAvailable()
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        const encrypted = await options.safeStorage.encryptStringAsync(
          JSON.stringify({ accountId, refreshToken })
        )
        await mkdir(options.directory, { recursive: true, mode: 0o700 })
        await writeFile(temporary, encrypted.toString('base64'), { mode: 0o600, flag: 'wx' })
        await rename(temporary, path)
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined)
        throw new Error('Relay credentials are unavailable')
      }
    },
    async delete(accountId): Promise<void> {
      try {
        await rm(pathFor(accountId))
      } catch (error) {
        // Filesystem errors can expose local paths; keep failures generic.
        // eslint-disable-next-line preserve-caught-error
        if (!isMissing(error)) throw new Error('Relay credentials are unavailable')
      }
    }
  }
}
