/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const config = loadTypeScript(new URL('../src/main/relay-config.ts', import.meta.url))

test('relay config gives launcher values precedence and reads local env only in development', () => {
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'https://relay.example' },
        isPackaged: false,
        localEnvPath: '/ignored'
      })
    },
    { baseUrl: 'https://relay.example' }
  )
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig(
        {
          environment: {},
          isPackaged: false,
          localEnvPath: '/dev/.env'
        },
        { readFile: () => 'HANTONG_RELAY_URL=http://127.0.0.1:8000' }
      )
    },
    {
      baseUrl: 'http://127.0.0.1:8000'
    }
  )
  assert.equal(
    config.loadRuntimeRelayConfig({
      environment: {},
      isPackaged: true,
      localEnvPath: '/ignored'
    }),
    undefined
  )
})

test('relay config rejects unsafe origins and IPv4 loopback aliases', () => {
  for (const value of [
    'http://localhost:8000',
    'http://localhost.evil:8000',
    'http://127.1:8000',
    'http://2130706433:8000',
    'http://127.0.0.1.evil:8000',
    'https://relay.example/path',
    'https://user:pass@relay.example',
    'https://relay.example/?secret=x'
  ]) {
    assert.throws(
      () =>
        config.loadRuntimeRelayConfig({
          environment: { HANTONG_RELAY_URL: value },
          isPackaged: false
        }),
      (error) => error.message === 'Relay configuration is invalid'
    )
  }
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'http://127.0.0.1:8000' },
        isPackaged: false
      })
    },
    { baseUrl: 'http://127.0.0.1:8000' }
  )
  assert.throws(
    () =>
      config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'http://127.0.0.1:8000' },
        isPackaged: true
      }),
    { message: 'Relay configuration is invalid' }
  )
})
