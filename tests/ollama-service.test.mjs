/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createOllamaService } = loadTypeScript(
  new URL('../src/main/ai/ollama/ollama-service.ts', import.meta.url)
)

function response(status, value, headers = {}) {
  return {
    status,
    headers: new Headers({ 'content-type': 'application/json', ...headers }),
    body: new Blob([JSON.stringify(value)]).stream()
  }
}

function fixture(routes) {
  const calls = []
  const service = createOllamaService({
    fetch: async (url, init) => {
      calls.push({ url, init })
      const route = routes.get(`${init.method} ${new URL(url).pathname}`)
      if (!route) throw new Error('unexpected request')
      return route
    }
  })
  return { service, calls }
}

test('Ollama status requires an explicit disabled cloud status from fixed loopback', async () => {
  const { service, calls } = fixture(
    new Map([['GET /api/status', response(200, { cloud: { disabled: true } })]])
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await service.getStatus())), {
    state: 'available',
    cloudDisabled: true
  })
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/status')
})

test('Ollama status fails closed when cloud state is absent or enabled', async () => {
  for (const payload of [{}, { cloud: { disabled: false } }, { cloud: { disabled: 'true' } }]) {
    const { service } = fixture(new Map([['GET /api/status', response(200, payload)]]))
    assert.deepEqual(JSON.parse(JSON.stringify(await service.getStatus())), {
      state: 'unavailable',
      cloudDisabled: false
    })
  }
})

test('model discovery excludes cloud aliases and models marked remote', async () => {
  const { service } = fixture(
    new Map([
      ['GET /api/status', response(200, { cloud: { disabled: true } })],
      [
        'GET /api/tags',
        response(200, {
          models: [
            { name: 'qwen3:8b', model: 'qwen3:8b', size: 1 },
            { name: 'llama:70b-cloud', model: 'llama:70b-cloud', size: 1 },
            {
              name: 'remote:latest',
              model: 'remote:latest',
              remote_host: 'https://ollama.com',
              remote_model: 'remote'
            },
            { name: 'remote2:latest', model: 'remote2:latest', remote_model: 'm' }
          ]
        })
      ]
    ])
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await service.getModels())), [
    { name: 'qwen3:8b', size: 1 }
  ])
})

test('model discovery is empty unless cloud is explicitly disabled', async () => {
  const { service, calls } = fixture(
    new Map([['GET /api/status', response(200, { cloud: { disabled: false } })]])
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await service.getModels())), [])
  assert.equal(calls.length, 1)
})

test('redirects and oversized responses are rejected without following them', async () => {
  const redirect = fixture(
    new Map([['GET /api/status', response(302, {}, { location: 'https://example.com' })]])
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await redirect.service.getStatus())), {
    state: 'unavailable',
    cloudDisabled: false
  })
  assert.equal(redirect.calls[0].init.redirect, 'manual')

  const oversized = fixture(
    new Map([
      [
        'GET /api/status',
        response(200, { cloud: { disabled: true } }, { 'content-length': '9999999' })
      ]
    ])
  )
  assert.deepEqual(JSON.parse(JSON.stringify(await oversized.service.getStatus())), {
    state: 'unavailable',
    cloudDisabled: false
  })
})

test('selection confirms the candidate with /api/show and refuses remote metadata', async () => {
  const { service } = fixture(
    new Map([
      ['GET /api/status', response(200, { cloud: { disabled: true } })],
      ['GET /api/tags', response(200, { models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] })],
      [
        'POST /api/show',
        response(200, {
          remote_host: 'https://ollama.com',
          remote_model: 'qwen3',
          capabilities: ['completion']
        })
      ]
    ])
  )
  await assert.rejects(service.validateModel('qwen3:8b'), /not available as a local model/)
})

test('chat uses fixed local endpoint, schema and non-streaming response', async () => {
  const { service, calls } = fixture(
    new Map([
      ['GET /api/status', response(200, { cloud: { disabled: true } })],
      ['GET /api/tags', response(200, { models: [{ name: 'qwen3:8b' }] })],
      ['POST /api/show', response(200, { capabilities: ['completion'] })],
      [
        'POST /api/chat',
        response(200, { message: { content: '{"kind":"answer","text":"hello"}' } })
      ]
    ])
  )
  const result = await service.generateChat(
    'qwen3:8b',
    'prompt',
    undefined,
    new AbortController().signal
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { kind: 'answer', text: 'hello' })
  const chat = calls.at(-1)
  assert.equal(chat.url, 'http://127.0.0.1:11434/api/chat')
  assert.equal(chat.init.redirect, 'manual')
  const body = JSON.parse(chat.init.body)
  assert.equal(body.stream, false)
  assert.ok(body.format.oneOf)
  for (const variant of body.format.oneOf) {
    assert.equal(variant.properties.text.type, 'string')
    assert.ok(variant.required.includes('text'))
    assert.equal(variant.additionalProperties, false)
  }
  assert.deepEqual(body.tools, [])
})

test('chat gets a separate bounded timeout longer than discovery requests', async () => {
  const service = createOllamaService({
    timeoutMs: 50,
    chatTimeoutMs: 200,
    fetch: async (url, init) => {
      const path = new URL(url).pathname
      if (path === '/api/status') return response(200, { cloud: { disabled: true } })
      if (path === '/api/tags') return response(200, { models: [{ name: 'gemma4:e2b' }] })
      if (path === '/api/show') return response(200, { capabilities: ['completion'] })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 75)
        init.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('chat request timed out'))
          },
          { once: true }
        )
      })
      return response(200, { message: { content: '{"kind":"answer","text":"ok"}' } })
    }
  })

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        await service.generateChat(
          'gemma4:e2b',
          'synthetic test prompt',
          undefined,
          new AbortController().signal
        )
      )
    ),
    { kind: 'answer', text: 'ok' }
  )
})

test('chat output is bounded and caller cancellation aborts transport', async () => {
  const oversized = fixture(
    new Map([
      ['GET /api/status', response(200, { cloud: { disabled: true } })],
      ['GET /api/tags', response(200, { models: [{ name: 'qwen3:8b' }] })],
      ['POST /api/show', response(200, { capabilities: ['completion'] })],
      ['POST /api/chat', response(200, { message: { content: 'x'.repeat(70_000) } })]
    ])
  )
  await assert.rejects(
    oversized.service.generateChat('qwen3:8b', 'prompt', undefined, new AbortController().signal),
    /too large/
  )
  let signal
  const cancelledCalls = []
  const cancelled = createOllamaService({
    fetch: (url, init) => {
      const path = new URL(url).pathname
      cancelledCalls.push(path)
      if (path === '/api/status')
        return Promise.resolve(response(200, { cloud: { disabled: true } }))
      if (path === '/api/tags')
        return Promise.resolve(response(200, { models: [{ name: 'qwen3:8b' }] }))
      if (path === '/api/show')
        return Promise.resolve(response(200, { capabilities: ['completion'] }))
      signal = init.signal
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      )
    }
  })
  const controller = new AbortController()
  const pending = cancelled.generateChat('qwen3:8b', 'prompt', undefined, controller.signal)
  while (!signal) await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  assert.equal(signal.aborted, true)
  await assert.rejects(pending)
  cancelled.dispose()
})

test('disposed service rejects future requests', async () => {
  const { service } = fixture(new Map())
  service.dispose()
  assert.deepEqual(JSON.parse(JSON.stringify(await service.getStatus())), {
    state: 'unavailable',
    cloudDisabled: false
  })
})

test('dispose aborts an in-flight status request', async () => {
  let signal
  const service = createOllamaService({
    fetch: (_url, init) => {
      signal = init.signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
  })
  const pending = service.getStatus()
  service.dispose()
  assert.equal(signal.aborted, true)
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    state: 'unavailable',
    cloudDisabled: false
  })
})

test('status requests time out even before a response arrives', async () => {
  let signal
  const service = createOllamaService({
    timeoutMs: 5,
    fetch: (_url, init) => {
      signal = init.signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
    }
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await service.getStatus())), {
    state: 'unavailable',
    cloudDisabled: false
  })
  assert.equal(signal.aborted, true)
  service.dispose()
})
