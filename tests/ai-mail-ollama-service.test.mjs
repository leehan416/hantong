/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAiMailOllamaGenerationService } = loadTypeScript(
  new URL('../src/main/ai/ollama/ai-mail-ollama-service.ts', import.meta.url)
)
const { redactAiMailInput } = loadTypeScript(
  new URL('../src/main/ai/redact-ai-mail-input.ts', import.meta.url)
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

test('both local and remote provider calls receive redacted synthetic input', async () => {
  for (const mode of ['local', 'remote']) {
    const h = harness()
    if (mode === 'remote')
      h.setSettings({ ...settingsBase, ollamaMode: 'remote', ollamaRemoteModel: 'cloud-model' })
    const sensitive = {
      ...request,
      prompt: 'Contact ada@example.test at https://example.test/?token=abc123'
    }
    await h.service.generate(sensitive, {}, () => true)
    const input = h.calls.find(([name]) => name === 'generate')[1].prompt
    assert.equal(input.includes('ada@example.test'), false)
    assert.equal(input.includes('abc123'), false)
    assert.match(input, /\[EMAIL\]/)
    assert.match(input, /\[LINK\]/)
  }
})

test('redaction masks synthetic sensitive values and preserves ordinary references', () => {
  const input = [
    'Password: sample-pass-42; API key=sample_api_key_value_123456789',
    'OTP: 123456 and account number 1234-5678-9012-3456 CVC: 321',
    'Identity 900101-1234567, email ada@example.test, phone +1 212-555-0100',
    'Visit https://example.test/path?token=synthetic-token and [portal](https://example.test/private)',
    'Order 2026-11-20, tracking 123456789012, shipment ETA 2026-11-21'
  ].join('\n')
  const result = redactAiMailInput(input)
  for (const secret of [
    'sample-pass-42',
    'sample_api_key_value_123456789',
    'OTP: 123456',
    'CVC: 321',
    '900101-1234567',
    'ada@example.test',
    '+1 212-555-0100',
    'https://example.test'
  ])
    assert.equal(result.includes(secret), false, secret)
  assert.match(result, /2026-11-20/)
  assert.match(result, /123456789012/)
  assert.match(result, /\[portal\]\(\[LINK\]\)/)
})

test('redaction handles URL email and token before contact patterns without leaking the suffix', () => {
  const result = redactAiMailInput(
    'https://mail.example.test/ada@example.test?token=synthetic-token, then contact ada@example.test'
  )
  assert.doesNotMatch(result, /mail\.example|ada@example\.test|synthetic-token/)
  assert.match(result, /^\[LINK\]/)
  assert.match(result, /\[EMAIL\]$/)
})

test('redaction hides formatted link destinations with balanced punctuation and angle form', () => {
  const result = redactAiMailInput(
    '[account](https://internal.example.test/a_(b)?token=sample), [internal](<custom://host/private?key=synthetic>)'
  )
  assert.doesNotMatch(result, /internal\.example|custom:\/\/|synthetic/)
  assert.match(result, /\[account\]\(\[LINK\]\)/)
  assert.match(result, /\[internal\]\(\[LINK\]\)/)
})

test('redaction covers Korean context labels and contiguous domestic phone numbers', () => {
  const input = [
    '비밀번호: sample-pass-42 인증번호 123456 계좌번호 110123456789',
    '이름: 홍길동 주소: 서울시 종로구 생년월일: 1990년 1월 2일',
    '연락처: 01012345678'
  ].join('\n')
  const result = redactAiMailInput(input)
  for (const value of [
    'sample-pass-42',
    '123456',
    '110123456789',
    '홍길동',
    '서울시 종로구',
    '1990년 1월 2일',
    '01012345678'
  ])
    assert.equal(result.includes(value), false, value)
})

test('redaction preserves ordinary ordering and tracking identifiers', () => {
  const input = 'Order 2026-11-20, order number 123456789012, tracking 12345678901234567890'
  assert.equal(redactAiMailInput(input), input)
})

test('redaction recognizes bare intranet, FTP and Slack links', () => {
  const input =
    'Fetch intranet.local/download?token=abc, ftp://files.example.test/path, slack://channel?id=abc'
  const result = redactAiMailInput(input)
  assert.doesNotMatch(result, /intranet\.local|files\.example|slack:\/\/|token=abc|id=abc/)
  assert.equal((result.match(/\[LINK\]/g) ?? []).length, 3)
})

test('redaction consumes balanced parentheses in markdown destinations', () => {
  const result = redactAiMailInput('[label](custom:abc(def)SECRET)')
  assert.equal(result, '[label]([LINK])')
  assert.doesNotMatch(result, /SECRET|custom:/)
})

test('redaction masks a contextual 15-digit card number', () => {
  const result = redactAiMailInput('Card number: 123456789012345')
  assert.doesNotMatch(result, /123456789012345/)
  assert.match(result, /\[FINANCIAL ID\]/)
})

test('redaction consumes bare host queries and ports as complete links before token masks', () => {
  const result = redactAiMailInput(
    'example.test?token=demo-secret example.test:8443/path?token=port-secret'
  )
  assert.doesNotMatch(result, /example\.test|demo-secret|8443|port-secret/)
  assert.equal((result.match(/\[LINK\]/g) ?? []).length, 2)
})

test('redaction recognizes JWT-like segments before bare-host matching', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyX2lkIjo0Mn0.signature_part_123'
  const result = redactAiMailInput(`https://auth.example.test/${token}`)
  assert.doesNotMatch(result, /eyJ|user_x5F|signature_part_123/)
  assert.match(result, /\[LINK\]/)
})

test('redaction preserves explicitly labeled 16-digit order and waybill identifiers', () => {
  const input = 'Order number: 1234567890123456; waybill: 9876543210987654'
  assert.equal(redactAiMailInput(input), input)
})

test('redaction masks quoted multiword passwords and Korean OTPs with particles', () => {
  const result = redactAiMailInput(
    'password: "correct horse battery staple" 인증번호는 123456입니다'
  )
  assert.doesNotMatch(result, /correct horse battery staple|123456/)
  assert.equal((result.match(/\[PASSWORD\]/g) ?? []).length, 1)
  assert.equal((result.match(/\[AUTH CODE\]/g) ?? []).length, 1)
})

test('redaction masks short-header JWTs even when a bare domain matcher is active', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'
  const result = redactAiMailInput(`Token ${token} example.test`)
  assert.doesNotMatch(result, /eyJhbGci|eyJzdWIi|\.sig/)
  assert.equal(result, 'Token [TOKEN] [LINK]')
})

test('redaction masks a complete multi-label URL and its sensitive suffix', () => {
  const result = redactAiMailInput('https://docs.team.example/path?token=synthetic')
  assert.equal(result, '[LINK]')
  assert.doesNotMatch(result, /docs\.team\.example|synthetic/)
})

test('redaction masks scheme-less IPv4 links with ports, paths and queries', () => {
  const result = redactAiMailInput('Visit 203.0.113.42:8443/path?token=synthetic')
  assert.doesNotMatch(result, /203\.0\.113\.42|8443|synthetic/)
})

test('redaction masks case-insensitive Markdown reference definitions with custom destinations', () => {
  const result = redactAiMailInput('[Portal]: custom://internal.example/private?key=synthetic')
  assert.doesNotMatch(result, /internal\.example|synthetic|custom:/)
  assert.match(result, /^\[Portal\]: \[LINK\]$/)
  assert.equal(redactAiMailInput('[portal]: custom:private/path'), '[portal]: [LINK]')
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
