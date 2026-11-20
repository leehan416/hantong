/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAiMailOllamaGenerationService } = loadTypeScript(
  new URL('../src/main/ai-mail-ollama-service.ts', import.meta.url)
)

const request = {
  accountId: 'account-a',
  composeId: 'compose-a',
  conversationId: '4f7307bb-aee2-44f7-a218-11893a2cb88f',
  requestId: 'request-a',
  generation: 1,
  prompt: 'private prompt'
}
const settingsBase = {
  aiMailProvider: 'ollama',
  ollamaMode: 'local',
  ollamaRemoteEndpoint: 'https://ollama.com/v1',
  ollamaModel: 'local-model',
  ollamaRemoteModel: null
}

function harness(overrides = {}) {
  let settings = { ...settingsBase }
  const calls = []
  const provider = {
    getStatus: async (configuration) => {
      calls.push(['status', configuration])
      return { state: 'available', cloudDisabled: true }
    },
    getModels: async (configuration) => {
      calls.push(['models', configuration])
      return [configuration.model].filter(Boolean)
    },
    generate: async (value, signal) => {
      calls.push(['generate', value, signal])
      return { kind: 'answer', text: 'safe response' }
    },
    dispose: async () => undefined,
    ...overrides.provider
  }
  const service = createAiMailOllamaGenerationService({
    provider,
    settings: () => settings,
    remoteCredential: overrides.remoteCredential ?? (async () => 'secret-key')
  })
  return {
    service,
    calls,
    provider,
    setSettings: (value) => {
      settings = value
    }
  }
}

test('remote generation uses the remote model and conversation identifier', async () => {
  const h = harness()
  h.setSettings({ ...settingsBase, ollamaMode: 'remote', ollamaRemoteModel: 'cloud-model' })
  const result = await h.service.generate(request, {}, () => true)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    output: { kind: 'answer', text: 'safe response' }
  })
  assert.equal(h.calls[0][1].model, 'cloud-model')
  assert.equal(
    h.calls.find(([name]) => name === 'generate')[1].conversationId,
    request.conversationId
  )
  assert.equal(h.calls.find(([name]) => name === 'generate')[1].apiKey, 'secret-key')
})

test('invalid conversation identity is rejected before the provider sees the prompt', async () => {
  const h = harness()
  const result = await h.service.generate(
    { ...request, conversationId: 'compose-a' },
    {},
    () => true
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: false,
    error: 'failed',
    reason: 'invalid_conversation'
  })
  assert.deepEqual(h.calls, [])
})

test('Ollama generation accepts the subject and body proposal contract used by the mail prompt', async () => {
  const h = harness({
    provider: {
      generate: async () => ({
        kind: 'proposal',
        subject: 'Monitor repair request',
        body: 'Hello IT, please check my monitor.'
      })
    }
  })
  const result = await h.service.generate(request, {}, () => true)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    ok: true,
    output: {
      kind: 'proposal',
      subject: 'Monitor repair request',
      body: 'Hello IT, please check my monitor.'
    }
  })
})

test('request slot is reserved before credential lookup and cancellation fences lookup', async () => {
  let resolveCredential
  const h = harness({
    remoteCredential: () =>
      new Promise((resolve) => {
        resolveCredential = resolve
      })
  })
  h.setSettings({ ...settingsBase, ollamaMode: 'remote', ollamaRemoteModel: 'cloud-model' })
  const first = h.service.generate(request, {}, () => true)
  assert.deepEqual(JSON.parse(JSON.stringify(await h.service.generate(request, {}, () => true))), {
    ok: false,
    error: 'failed',
    reason: 'duplicate_request'
  })
  assert.equal(h.service.cancel(request.requestId), true)
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), {
    ok: false,
    error: 'cancelled',
    reason: 'cancelled'
  })
  assert.equal(h.calls.length, 0)
  resolveCredential('secret-key')
})

test('remote settings changes during discovery prevent using the stale model', async () => {
  let resolveModels
  const h = harness({
    provider: {
      getModels: () =>
        new Promise((resolve) => {
          resolveModels = resolve
        })
    }
  })
  h.setSettings({ ...settingsBase, ollamaMode: 'remote', ollamaRemoteModel: 'cloud-model' })
  const pending = h.service.generate(request, {}, () => true)
  while (!resolveModels) await new Promise((resolve) => setImmediate(resolve))
  h.setSettings({ ...settingsBase, ollamaMode: 'remote', ollamaRemoteModel: 'other-model' })
  resolveModels(['cloud-model'])
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: false,
    error: 'cancelled',
    reason: 'stale'
  })
  assert.equal(
    h.calls.some(([name]) => name === 'generate'),
    false
  )
})

test('provider output is validated and stale results are fenced', async () => {
  const bad = harness({
    provider: {
      generate: async () => ({ kind: 'proposal', field: 'body', text: 'x', extra: true })
    }
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(await bad.service.generate(request, {}, () => true))),
    {
      ok: false,
      error: 'failed',
      reason: 'invalid_output'
    }
  )

  const stale = harness({ provider: { generate: async () => ({ kind: 'answer', text: 'late' }) } })
  assert.deepEqual(
    JSON.parse(JSON.stringify(await stale.service.generate(request, {}, () => false))),
    {
      ok: false,
      error: 'cancelled',
      reason: 'stale'
    }
  )
})

test('cancellation during discovery aborts provider requests and does not generate', async () => {
  let signal
  let resolveModels
  const h = harness({
    provider: {
      getModels: (_configuration, value) => {
        signal = value
        return new Promise((resolve) => {
          resolveModels = resolve
        })
      }
    }
  })
  const pending = h.service.generate(request, {}, () => true)
  while (!resolveModels) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.service.cancel(request.requestId), true)
  assert.equal(signal.aborted, true)
  resolveModels(['local-model'])
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: false,
    error: 'cancelled',
    reason: 'cancelled'
  })
  assert.equal(
    h.calls.some(([name]) => name === 'generate'),
    false
  )
})
