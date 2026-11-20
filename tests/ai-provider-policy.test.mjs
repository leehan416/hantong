import test from 'node:test'
import assert from 'node:assert/strict'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { normalizeRemoteOllamaEndpoint, isValidRemoteOllamaEndpoint } = loadTypeScript(
  new URL('../src/main/ai/ai-provider-policy.ts', import.meta.url)
)

test('remote Ollama endpoints require HTTPS and normalize to a versioned API root', () => {
  assert.equal(normalizeRemoteOllamaEndpoint('https://ollama.com'), 'https://ollama.com/v1')
  assert.equal(
    normalizeRemoteOllamaEndpoint('https://models.example/api/v1/'),
    'https://models.example/api/v1'
  )
  for (const endpoint of [
    'http://ollama.com',
    'https://user:pass@ollama.com',
    'https://ollama.com/path?token=x',
    'https://localhost:11434',
    'https://127.0.0.1:11434',
    'https://127.22.3.4:11434',
    'https://my-service.localhost:11434',
    'https://[::1]:11434',
    'file:///etc/passwd'
  ]) {
    assert.equal(isValidRemoteOllamaEndpoint(endpoint), false, endpoint)
    assert.throws(() => normalizeRemoteOllamaEndpoint(endpoint))
  }
})
