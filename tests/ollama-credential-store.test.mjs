import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createOllamaCredentialStore } = loadTypeScript(
  new URL('../src/main/ai/ollama/ollama-credential-store.ts', import.meta.url)
)

test('remote credentials are encrypted at rest and can be cleared without returning them to UI', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-ollama-credentials-'))
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value) => Buffer.from(value).toString('base64'),
    decryptStringAsync: async (value) => ({
      result: Buffer.from(value.toString(), 'base64').toString(),
      shouldReEncrypt: false
    })
  }
  try {
    const store = createOllamaCredentialStore({ directory, safeStorage })
    const endpoint = 'https://ollama.com/v1'
    const otherEndpoint = 'https://models.example/v1'
    await store.set(endpoint, 'secret-key')
    assert.equal(await store.has(endpoint), true)
    assert.equal(await store.get(endpoint), 'secret-key')
    assert.equal(await store.has(otherEndpoint), false)
    assert.equal(await store.get(otherEndpoint), null)
    const digest = createHash('sha256').update(endpoint).digest('hex')
    assert.doesNotMatch(
      readFileSync(join(directory, `ollama-api-key-${digest}.enc`), 'utf8'),
      /secret-key/
    )
    await store.clear(endpoint)
    assert.equal(await store.has(endpoint), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('credential removal deletes the endpoint file when protected storage cannot decrypt it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-ollama-credentials-'))
  const endpoint = 'https://ollama.com/v1'
  const digest = createHash('sha256').update(endpoint).digest('hex')
  const file = join(directory, `ollama-api-key-${digest}.enc`)
  const store = createOllamaCredentialStore({
    directory,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async () => {
        throw new Error('cannot decrypt')
      }
    }
  })
  try {
    writeFileSync(file, 'unreadable encrypted credential')
    await store.clear(endpoint)
    assert.equal(existsSync(file), false)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('credential removal reports an endpoint file deletion failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-ollama-credentials-'))
  const endpoint = 'https://ollama.com/v1'
  const digest = createHash('sha256').update(endpoint).digest('hex')
  const store = createOllamaCredentialStore({
    directory,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => false,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async () => {
        throw new Error('cannot decrypt')
      }
    }
  })
  try {
    mkdirSync(join(directory, `ollama-api-key-${digest}.enc`))
    await assert.rejects(store.clear(endpoint))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('credential save rechecks the requesting owner before committing encrypted data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-ollama-credentials-'))
  const store = createOllamaCredentialStore({
    directory,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => Buffer.from(value),
      decryptStringAsync: async (value) => value.toString()
    }
  })
  try {
    await assert.rejects(
      store.set('https://ollama.com/v1', 'secret-key', () => {
        throw new Error('stale owner')
      }),
      /Unable to save protected credential/
    )
    assert.equal(await store.get('https://ollama.com/v1'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('credential writes reject header control characters and serialize set before clear', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-ollama-credentials-'))
  let releaseEncryption
  const store = createOllamaCredentialStore({
    directory,
    safeStorage: {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (value) => {
        await new Promise((resolve) => {
          releaseEncryption = resolve
        })
        return Buffer.from(value)
      },
      decryptStringAsync: async (value) => value.toString()
    }
  })
  try {
    await assert.rejects(store.set('https://ollama.com/v1', 'bad\r\nvalue'), /Invalid credential/)
    const save = store.set('https://ollama.com/v1', 'safe-key')
    while (!releaseEncryption) await new Promise((resolve) => setImmediate(resolve))
    const clear = store.clear('https://ollama.com/v1')
    releaseEncryption()
    await Promise.all([save, clear])
    assert.equal(await store.get('https://ollama.com/v1'), null)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
