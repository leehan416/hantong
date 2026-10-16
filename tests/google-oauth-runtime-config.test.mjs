/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these test helpers as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const runtimeConfig = loadTypeScript(
  new URL('../src/main/google-oauth-runtime-config.ts', import.meta.url)
)

const clientId = 'desktop-client.apps.googleusercontent.com'

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-oauth-config-'))
  try {
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('local dev config parses quoted values and comments using Node dotenv semantics', async () => {
  await withDirectory(async (directory) => {
    const localEnvPath = join(directory, '.env')
    const secret = 'example-secret#with-comment-marker'
    await writeFile(
      localEnvPath,
      `# Hantong local OAuth\nHANTONG_GOOGLE_CLIENT_ID="${clientId}" # client id\nHANTONG_GOOGLE_CLIENT_SECRET='${secret}' # optional secret\nUNRELATED=value\n`
    )

    const config = runtimeConfig.loadRuntimeGoogleOAuthConfig({
      environment: {},
      isPackaged: false,
      localEnvPath
    })

    assert.deepEqual({ ...config }, { clientId, clientSecret: secret })
  })
})

test('launcher credentials take precedence as a pair without mixing the local secret', async () => {
  await withDirectory(async (directory) => {
    const localEnvPath = join(directory, '.env')
    await writeFile(
      localEnvPath,
      `HANTONG_GOOGLE_CLIENT_ID=${clientId}\nHANTONG_GOOGLE_CLIENT_SECRET=local-secret\n`
    )
    let reads = 0
    const config = runtimeConfig.loadRuntimeGoogleOAuthConfig(
      {
        environment: { HANTONG_GOOGLE_CLIENT_ID: clientId },
        isPackaged: false,
        localEnvPath
      },
      {
        readFile: (...args) => {
          reads += 1
          return readFileSync(...args)
        }
      }
    )

    assert.deepEqual({ ...config }, { clientId })
    assert.equal(reads, 0)
  })
})

test('blank ID and secret-only launcher overrides fail closed without reading local config', () => {
  for (const environment of [
    { HANTONG_GOOGLE_CLIENT_ID: '' },
    { HANTONG_GOOGLE_CLIENT_SECRET: 'launcher-secret' }
  ]) {
    let reads = 0
    assert.throws(
      () =>
        runtimeConfig.loadRuntimeGoogleOAuthConfig(
          { environment, isPackaged: false, localEnvPath: '/unused/.env' },
          {
            readFile: () => {
              reads += 1
              return ''
            }
          }
        ),
      /HANTONG_GOOGLE_CLIENT_ID/
    )
    assert.equal(reads, 0)
  }

  assert.deepEqual(
    {
      ...runtimeConfig.loadRuntimeGoogleOAuthConfig({
        environment: { HANTONG_GOOGLE_CLIENT_ID: clientId, HANTONG_GOOGLE_CLIENT_SECRET: '' },
        isPackaged: false,
        localEnvPath: '/unused/.env'
      })
    },
    { clientId }
  )
})

test('packaged runtime never reads a local config path', () => {
  let reads = 0
  assert.throws(
    () =>
      runtimeConfig.loadRuntimeGoogleOAuthConfig(
        { environment: {}, isPackaged: true, localEnvPath: '/must-not-read/.env' },
        {
          readFile: () => {
            reads += 1
            return `HANTONG_GOOGLE_CLIENT_ID=${clientId}`
          }
        }
      ),
    /HANTONG_GOOGLE_CLIENT_ID/
  )
  assert.equal(reads, 0)
})

test('a missing local file fails as missing configuration without disclosing its path', () => {
  const privateMarker = 'synthetic-private-config-marker'
  assert.throws(
    () =>
      runtimeConfig.loadRuntimeGoogleOAuthConfig(
        { environment: {}, isPackaged: false, localEnvPath: '/private/location/.env' },
        {
          readFile: () => {
            throw Object.assign(new Error(`ENOENT ${privateMarker} /private/location/.env`), {
              code: 'ENOENT'
            })
          }
        }
      ),
    (error) => {
      assert.equal(error.message.includes(privateMarker), false)
      assert.equal(error.message.includes('/private/location/.env'), false)
      return true
    }
  )
})

test('local file read errors are replaced with sanitized configuration errors', () => {
  const privateMarker = 'synthetic-private-config-marker'
  assert.throws(
    () =>
      runtimeConfig.loadRuntimeGoogleOAuthConfig(
        { environment: {}, isPackaged: false, localEnvPath: '/private/location/.env' },
        {
          readFile: () => {
            throw new Error(`EACCES ${privateMarker} /private/location/.env`)
          }
        }
      ),
    (error) => {
      assert.equal(error.message.includes(privateMarker), false)
      assert.equal(error.message.includes('/private/location/.env'), false)
      assert.equal(error.cause, undefined)
      return true
    }
  )
})

test('parser errors are replaced with sanitized configuration errors', () => {
  const privateMarker = 'synthetic-private-config-marker'
  assert.throws(
    () =>
      runtimeConfig.loadRuntimeGoogleOAuthConfig(
        { environment: {}, isPackaged: false, localEnvPath: '/private/location/.env' },
        {
          readFile: () => `HANTONG_GOOGLE_CLIENT_ID=${clientId}`,
          parseEnv: () => {
            throw new Error(privateMarker)
          }
        }
      ),
    (error) => {
      assert.equal(error.message.includes(privateMarker), false)
      assert.equal(error.message.includes('/private/location/.env'), false)
      assert.equal(error.cause, undefined)
      return true
    }
  )
})

test('malformed local config fails without disclosing contents', async () => {
  const privateMarker = 'synthetic-private-config-marker'
  await withDirectory(async (directory) => {
    const localEnvPath = join(directory, '.env')
    await writeFile(localEnvPath, `${privateMarker}="unterminated`)
    assert.throws(
      () =>
        runtimeConfig.loadRuntimeGoogleOAuthConfig({
          environment: {},
          isPackaged: false,
          localEnvPath
        }),
      (error) => {
        assert.equal(error.message.includes(privateMarker), false)
        assert.equal(error.message.includes(localEnvPath), false)
        return true
      }
    )
  })
})

test('reading local config does not mutate process.env', async () => {
  await withDirectory(async (directory) => {
    const localEnvPath = join(directory, '.env')
    await writeFile(localEnvPath, `HANTONG_GOOGLE_CLIENT_ID=${clientId}\n`)
    const before = { ...process.env }
    runtimeConfig.loadRuntimeGoogleOAuthConfig({
      environment: {},
      isPackaged: false,
      localEnvPath
    })
    assert.deepEqual({ ...process.env }, before)
  })
})
