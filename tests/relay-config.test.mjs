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
    { baseUrl: 'https://relay.example/api/v1/' }
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
      baseUrl: 'http://127.0.0.1:8000/api/v1/'
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
    'http://127.0.0.1:8000/api/v1/../other',
    'http://127.0.0.1:8000/%61pi',
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
    { baseUrl: 'http://127.0.0.1:8000/api/v1/' }
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

test('relay config appends or keeps the /api/v1 prefix and rejects path aliases', () => {
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'https://relay.example/api/v1/' },
        isPackaged: true
      })
    },
    { baseUrl: 'https://relay.example/api/v1/' }
  )
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'http://127.0.0.1:8000/api/v1' },
        isPackaged: false
      })
    },
    { baseUrl: 'http://127.0.0.1:8000/api/v1/' }
  )
  for (const value of [
    'https://relay.example/api',
    'https://relay.example/api/',
    'https://relay.example/api/v2/',
    'https://relay.example/api/v1/../other',
    'https://relay.example/%61pi',
    'https://relay.example/api%2f..%2fother',
    'https://relay.example/api/v1?x=1',
    'https://relay.example/api/v1#x'
  ]) {
    assert.throws(
      () =>
        config.loadRuntimeRelayConfig({
          environment: { HANTONG_RELAY_URL: value },
          isPackaged: true
        }),
      { message: 'Relay configuration is invalid' }
    )
  }
})

test('relay config carries a valid Gmail topic from the same source and rejects malformed ones', () => {
  const topic = 'projects/hantong-dev/topics/gmail-changes'
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig({
        environment: { HANTONG_RELAY_URL: 'https://relay.example', HANTONG_GMAIL_TOPIC: topic },
        isPackaged: true
      })
    },
    { baseUrl: 'https://relay.example/api/v1/', gmailTopic: topic }
  )
  assert.deepEqual(
    {
      ...config.loadRuntimeRelayConfig(
        { environment: {}, isPackaged: false, localEnvPath: '/dev/.env' },
        {
          readFile: () => `HANTONG_RELAY_URL=http://127.0.0.1:8000\nHANTONG_GMAIL_TOPIC=${topic}`
        }
      )
    },
    { baseUrl: 'http://127.0.0.1:8000/api/v1/', gmailTopic: topic }
  )
  assert.equal(
    config.loadRuntimeRelayConfig({
      environment: { HANTONG_GMAIL_TOPIC: topic },
      isPackaged: true
    }),
    undefined
  )
  for (const value of ['gmail-changes', 'projects/x/subscriptions/y', 'projects/x/topics/y\nz']) {
    assert.throws(
      () =>
        config.loadRuntimeRelayConfig({
          environment: { HANTONG_RELAY_URL: 'https://relay.example', HANTONG_GMAIL_TOPIC: value },
          isPackaged: true
        }),
      { message: 'Relay configuration is invalid' }
    )
  }
})
