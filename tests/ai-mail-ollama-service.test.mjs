/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAiMailOllamaGenerationService } = loadTypeScript(
  new URL('../src/main/ai-mail-ollama-service.ts', import.meta.url)
)

const request = {
  accountId: 'account1',
  composeId: 'compose1',
  requestId: 'request1',
  generation: 1,
  prompt: 'fixture only'
}
const ready = { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' }

function harness(overrides = {}) {
  let settings = { ...ready }
  const calls = []
  const ollama = {
    getStatus: async () => {
      calls.push('status')
      return { state: 'available', cloudDisabled: true }
    },
    validateModel: async (model) => {
      calls.push(['validate', model])
    },
    generateChat: async (_model, prompt, _followUp, signal) => {
      calls.push(['chat', prompt])
      if (overrides.chat) return overrides.chat(signal)
      return { kind: 'answer', text: 'safe response' }
    }
  }
  const service = createAiMailOllamaGenerationService({ ollama, settings: () => settings })
  return {
    service,
    calls,
    setSettings: (value) => {
      settings = value
    }
  }
}

test('generation preserves answer and editable proposal variants', async () => {
  for (const output of [
    { kind: 'answer', text: 'explanation' },
    { kind: 'proposal', field: 'body', text: 'draft body' },
    { kind: 'proposal', field: 'subject', text: 'draft body', subject: 'draft subject' }
  ]) {
    const h = harness({ chat: async () => output })
    assert.deepEqual(
      JSON.parse(JSON.stringify(await h.service.generate(request, {}, () => true))),
      { ok: true, output }
    )
    h.service.dispose()
  }
})

test('generation rejects malformed output and enforces provider readiness', async () => {
  const bad = harness({
    chat: async () => ({ kind: 'proposal', field: 'body', text: 'x', extra: true })
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(await bad.service.generate(request, {}, () => true))),
    {
      ok: false,
      error: 'failed',
      reason: 'invalid_output'
    }
  )
  const unknown = harness()
  unknown.setSettings({ aiMailProvider: 'codex', ollamaModel: null })
  assert.equal((await unknown.service.generate(request, {}, () => true)).error, 'unavailable')
  assert.deepEqual(unknown.calls, [])
})

test('duplicate request IDs are rejected and cancellation during readiness fences results', async () => {
  let settle
  const statusPending = new Promise((resolve) => {
    settle = resolve
  })
  const model = { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' }
  const svc = createAiMailOllamaGenerationService({
    ollama: {
      getStatus: () => statusPending,
      validateModel: async () => {},
      generateChat: async () => ({ kind: 'answer', text: 'late' })
    },
    settings: () => model
  })
  const r = { ...request, requestId: 'dupe' }
  const first = svc.generate(r, {}, () => true)
  assert.deepEqual(JSON.parse(JSON.stringify(await svc.generate(r, {}, () => true))), {
    ok: false,
    error: 'failed',
    reason: 'duplicate_request'
  })
  assert.equal(svc.cancel('dupe'), true)
  settle({ state: 'available', cloudDisabled: true })
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), {
    ok: false,
    error: 'cancelled',
    reason: 'stale'
  })
  svc.dispose()
})

test('provider/model changes and disposal reject late chat responses without content logging', async () => {
  let resolveChat
  const h = harness({
    chat: () =>
      new Promise((resolve) => {
        resolveChat = resolve
      })
  })
  const owner = {}
  const pending = h.service.generate(request, owner, () => true)
  while (!resolveChat) await new Promise((resolve) => setImmediate(resolve))
  h.setSettings({ aiMailProvider: 'ollama', ollamaModel: 'other:latest' })
  resolveChat({ kind: 'answer', text: 'private content' })
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), {
    ok: false,
    error: 'cancelled',
    reason: 'stale'
  })

  let signal
  const disposing = harness({
    chat: (value) => {
      signal = value
      return new Promise((resolve) => {
        value.addEventListener('abort', () => resolve({ kind: 'answer', text: 'late' }), {
          once: true
        })
      })
    }
  })
  const work = disposing.service.generate(request, owner, () => true)
  while (!signal) await new Promise((resolve) => setImmediate(resolve))
  disposing.service.dispose()
  assert.equal(signal.aborted, true)
  await work
})
