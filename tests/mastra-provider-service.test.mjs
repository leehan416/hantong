/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JavaScript types. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createMastraOllamaProvider } = loadTypeScript(
  new URL('../src/main/mastra-ollama-provider.ts', import.meta.url),
  { Response: globalThis.Response, Request: globalThis.Request, Headers: globalThis.Headers }
)

const answer = (text = 'safe response') =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ kind: 'answer', text }) } }]
    }),
    { status: 200 }
  )
const local = {
  getStatus: async () => ({ state: 'available', cloudDisabled: true }),
  getModels: async () => [{ name: 'local-model', size: null }],
  validateModel: async () => undefined
}
const request = (overrides = {}) => ({
  mode: 'local',
  endpoint: 'ignored',
  apiKey: null,
  model: 'local-model',
  accountId: 'account-a',
  conversationId: 'conversation-a',
  prompt: 'turn marker',
  isCurrent: () => true,
  ...overrides
})

test('provider selection stays explicit and remote mode never uses the local adapter', async () => {
  const calls = []
  const provider = createMastraOllamaProvider({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init })
      if (String(url).endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'qwen3:cloud' }] }), { status: 200 })
      if (String(url).includes('/chat/completions')) return answer('remote')
      throw new Error('unexpected request')
    },
    local: {
      ...local,
      getStatus: async () => {
        throw new Error('remote used local status')
      }
    }
  })
  const remote = {
    mode: 'remote',
    endpoint: 'https://ollama.com/v1',
    apiKey: 'secret',
    model: 'qwen3:cloud'
  }
  assert.deepEqual(await provider.getModels(remote), ['qwen3:cloud'])
  const result = await provider.generate(request({ ...remote }), new AbortController().signal)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { kind: 'answer', text: 'remote' })
  assert.equal(
    calls.filter((call) => call.url).every((call) => new URL(call.url).protocol === 'https:'),
    true
  )
  assert.equal(
    calls.filter((call) => call.url).every((call) => call.init.redirect === 'manual'),
    true
  )
  await provider.dispose()
})

test('provider retains a subject and body proposal in the mail prompt contract', async () => {
  const provider = createMastraOllamaProvider({
    fetch: async (url) => {
      if (String(url).includes('/chat/completions'))
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    kind: 'proposal',
                    subject: 'Monitor repair request',
                    body: 'Hello IT, please check my monitor.'
                  })
                }
              }
            ]
          }),
          { status: 200 }
        )
      throw new Error('unexpected request')
    },
    local
  })
  const result = await provider.generate(request(), new AbortController().signal)
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: 'proposal',
    subject: 'Monitor repair request',
    body: 'Hello IT, please check my monitor.'
  })
  await provider.dispose()
})

test('memory is isolated by account, conversation, mode, and canonical endpoint', async () => {
  const bodies = []
  const provider = createMastraOllamaProvider({
    fetch: async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        bodies.push(JSON.parse(init.body))
        return answer('remembered')
      }
      throw new Error('unexpected request')
    },
    local
  })
  const base = request({ prompt: 'first-turn-marker' })
  await provider.generate(base, new AbortController().signal)
  await provider.generate({ ...base, prompt: 'second-turn-marker' }, new AbortController().signal)
  await provider.generate(
    { ...base, accountId: 'account-b', prompt: 'account-marker' },
    new AbortController().signal
  )
  await provider.generate(
    { ...base, conversationId: 'conversation-b', prompt: 'conversation-marker' },
    new AbortController().signal
  )
  await provider.generate(
    {
      ...base,
      mode: 'remote',
      endpoint: 'https://ollama.com/v1',
      apiKey: 'key',
      model: 'cloud-model',
      prompt: 'remote-marker'
    },
    new AbortController().signal
  )
  await provider.generate(
    {
      ...base,
      mode: 'remote',
      endpoint: 'https://models.example/v1',
      apiKey: 'key',
      model: 'cloud-model',
      prompt: 'endpoint-marker'
    },
    new AbortController().signal
  )
  const history = (index) => JSON.stringify(bodies[index].messages)
  assert.match(history(1), /first-turn-marker|remembered/)
  for (const index of [2, 3, 4, 5])
    assert.doesNotMatch(history(index), /first-turn-marker|second-turn-marker|remembered/)
  await provider.dispose()
})

test('malformed successful responses do not retain the turn or log prompt, key, or result', async () => {
  const outputs = ['not json prompt-marker key-marker result-marker', null]
  const logs = []
  const originalError = console.error
  console.error = (...values) => logs.push(values.join(' '))
  const bodies = []
  const provider = createMastraOllamaProvider({
    fetch: async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        bodies.push(JSON.parse(init.body))
        const content = outputs.shift() ?? JSON.stringify({ kind: 'answer', text: 'ok' })
        return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200
        })
      }
      throw new Error('unexpected request')
    },
    local
  })
  const config = request({
    mode: 'remote',
    endpoint: 'https://ollama.com/v1',
    apiKey: 'key-marker',
    model: 'remote-model',
    prompt: 'prompt-marker'
  })
  try {
    await assert.rejects(provider.generate(config, new AbortController().signal), /failed/i)
    await provider.generate({ ...config, prompt: 'follow-up' }, new AbortController().signal)
    assert.doesNotMatch(JSON.stringify(bodies[1].messages), /prompt-marker|result-marker/)
    assert.doesNotMatch(logs.join(' '), /prompt-marker|key-marker|result-marker/)
  } finally {
    console.error = originalError
    await provider.dispose()
  }
})

test('stale completion deletes its memory thread before a later turn', async () => {
  const bodies = []
  let current = false
  const provider = createMastraOllamaProvider({
    fetch: async (url, init) => {
      if (String(url).includes('/chat/completions')) {
        bodies.push(JSON.parse(init.body))
        return answer('late result')
      }
      throw new Error('unexpected request')
    },
    local
  })
  await provider.generate(request({ isCurrent: () => current }), new AbortController().signal)
  await provider.generate(request({ prompt: 'fresh marker' }), new AbortController().signal)
  assert.doesNotMatch(JSON.stringify(bodies[1].messages), /turn marker|late result/)
  await provider.dispose()
})

test('remote redirects and oversized responses are rejected', async () => {
  const provider = createMastraOllamaProvider({
    fetch: async () =>
      new Response('', { status: 302, headers: { location: 'http://127.0.0.1:11434' } }),
    local
  })
  await assert.rejects(
    provider.getModels({ mode: 'remote', endpoint: 'https://ollama.com/v1', apiKey: 'key' }),
    /rejected/i
  )
  await provider.dispose()
})

test('remote credential changes do not retain an old credential-bearing Agent', async () => {
  const createdAgents = []
  class TestMemory {
    deleteThread() {
      return Promise.resolve()
    }
    settled() {
      return Promise.resolve()
    }
  }
  class TestAgent {
    constructor(options) {
      this.options = options
      createdAgents.push(this)
    }
    async generate() {
      return { text: JSON.stringify({ kind: 'answer', text: 'ok' }) }
    }
  }
  const loadProvider = loadTypeScript(
    new URL('../src/main/mastra-ollama-provider.ts', import.meta.url),
    {
      Response: globalThis.Response,
      Request: globalThis.Request,
      Headers: globalThis.Headers,
      '@ai-sdk/openai-compatible': {
        createOpenAICompatible: ({ apiKey }) => ({ chatModel: (model) => ({ apiKey, model }) })
      },
      '@mastra/core/agent': { Agent: TestAgent },
      '@mastra/core/mastra': { Mastra: class TestMastra {} },
      '@mastra/core/storage': { InMemoryStore: class TestInMemoryStore {} },
      '@mastra/memory': { Memory: TestMemory }
    }
  )
  const provider = loadProvider.createMastraOllamaProvider({
    local,
    fetch: async () => {
      throw new Error('unexpected network request')
    }
  })
  const remote = request({
    mode: 'remote',
    endpoint: 'https://ollama.com/v1',
    apiKey: 'old-secret',
    model: 'remote-model'
  })
  await provider.generate(remote, new AbortController().signal)
  await provider.generate({ ...remote, apiKey: 'new-secret' }, new AbortController().signal)
  assert.equal(createdAgents.length, 2)
  assert.equal(createdAgents[0].options.model.apiKey, 'old-secret')
  assert.equal(createdAgents[1].options.model.apiKey, 'new-secret')
  await provider.dispose()
})
