import { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isAccountId } from './account-state'

export interface GoogleProtectedCredential {
  readonly refreshToken: string
  readonly emailAddress: string
}

export type GoogleSafeStorage = Pick<
  Electron.SafeStorage,
  'isAsyncEncryptionAvailable' | 'encryptStringAsync' | 'decryptStringAsync'
>

export interface GoogleCredentialStoreOptions {
  readonly directory: string
  readonly platform: NodeJS.Platform
  readonly safeStorage: GoogleSafeStorage
}

export class GoogleCredentialStoreFailure extends Error {
  readonly code = 'unavailable'

  constructor() {
    super('Protected Google credentials are unavailable')
    this.name = 'GoogleCredentialStoreFailure'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validCredential(
  value: unknown,
  accountId: string
): value is Record<string, unknown> & {
  readonly refreshToken: string
  readonly emailAddress: string
} {
  if (!isRecord(value)) return false
  const record = value
  return (
    Object.keys(record).sort().join(',') === 'accountId,emailAddress,refreshToken,schemaVersion' &&
    record.schemaVersion === 1 &&
    record.accountId === accountId &&
    typeof record.refreshToken === 'string' &&
    record.refreshToken.trim().length > 0 &&
    typeof record.emailAddress === 'string' &&
    /^[^\s@]+@[^\s@]+$/.test(record.emailAddress)
  )
}

export function createGoogleCredentialStore(options: GoogleCredentialStoreOptions): {
  read(accountId: string): Promise<GoogleProtectedCredential | null>
  write(accountId: string, credential: GoogleProtectedCredential): Promise<void>
  delete(accountId: string): Promise<void>
} {
  const pathFor = (accountId: string): string => {
    if (!isAccountId(accountId)) throw new GoogleCredentialStoreFailure()
    return join(options.directory, `${accountId}.credential`)
  }

  const ensureAvailable = async (): Promise<void> => {
    if (options.platform !== 'darwin') throw new GoogleCredentialStoreFailure()
    try {
      if ((await options.safeStorage.isAsyncEncryptionAvailable()) !== true) {
        throw new GoogleCredentialStoreFailure()
      }
    } catch {
      throw new GoogleCredentialStoreFailure()
    }
  }

  const writeCiphertext = async (path: string, plaintext: string): Promise<void> => {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const encrypted = await options.safeStorage.encryptStringAsync(plaintext)
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new GoogleCredentialStoreFailure()
      }
      await mkdir(options.directory, { recursive: true, mode: 0o700 })
      await writeFile(temporary, encrypted.toString('base64'), { mode: 0o600, flag: 'wx' })
      await rename(temporary, path)
    } catch {
      try {
        await rm(temporary, { force: true })
      } catch {
        // A failed cleanup must not replace the sanitized storage error.
      }
      throw new GoogleCredentialStoreFailure()
    }
  }

  const readCredential = async (accountId: string): Promise<GoogleProtectedCredential | null> => {
    const path = pathFor(accountId)
    await ensureAvailable()
    let encoded: string
    try {
      encoded = await readFile(path, 'utf8')
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return null
      }
      throw new GoogleCredentialStoreFailure()
    }
    try {
      const bytes = Buffer.from(encoded, 'base64')
      if (!bytes.length || bytes.toString('base64') !== encoded) throw new Error('Invalid record')
      const decrypted = await options.safeStorage.decryptStringAsync(bytes)
      const value: unknown = JSON.parse(decrypted.result)
      if (!validCredential(value, accountId)) throw new Error('Invalid record')
      const credential = { refreshToken: value.refreshToken, emailAddress: value.emailAddress }
      if (decrypted.shouldReEncrypt) {
        const plaintext = JSON.stringify({ schemaVersion: 1, accountId, ...credential })
        await writeCiphertext(path, plaintext)
      }
      return credential
    } catch {
      throw new GoogleCredentialStoreFailure()
    }
  }

  return {
    read: readCredential,
    async write(accountId, credential): Promise<void> {
      const path = pathFor(accountId)
      await ensureAvailable()
      if (
        typeof credential.refreshToken !== 'string' ||
        !credential.refreshToken.trim() ||
        typeof credential.emailAddress !== 'string' ||
        !/^[^\s@]+@[^\s@]+$/.test(credential.emailAddress)
      ) {
        throw new GoogleCredentialStoreFailure()
      }
      await readCredential(accountId)
      const plaintext = JSON.stringify({
        schemaVersion: 1,
        accountId,
        refreshToken: credential.refreshToken,
        emailAddress: credential.emailAddress
      })
      await writeCiphertext(path, plaintext)
    },
    async delete(accountId): Promise<void> {
      const path = pathFor(accountId)
      if (options.platform !== 'darwin') throw new GoogleCredentialStoreFailure()
      try {
        await rm(path)
      } catch (error) {
        if (
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return
        }
        throw new GoogleCredentialStoreFailure()
      }
    }
  }
}
