/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Test helper runs in plain JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAiMailCodexService } = loadTypeScript(
  new URL('../src/main/ai-mail-codex-service.ts', import.meta.url)
)
const { isAllowedAiMailCodexRequest } = loadTypeScript(
  new URL('../src/main/security-policy.ts', import.meta.url)
)

const request = {
  accountId: 'account_1',
  composeId: 'compose_1',
  requestId: 'request_1',
  generation: 1,
  prompt: 'Synthetic fixture only: write a short greeting.'
}
const renderer = 'file:///Applications/Hantong.app/Contents/Resources/app/index.html'
const base = {
  ownerAlive: true,
  senderMatches: true,
  mainFrameMatches: true,
  senderUrl: renderer,
  rendererUrl: renderer
}
const plain = (value) => JSON.parse(JSON.stringify(value))

test('Codex is explicitly unsupported without launching an external installation', async () => {
  const service = createAiMailCodexService()
  assert.deepEqual(plain(service.getStatus()), {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
  assert.deepEqual(plain(await service.connect()), plain(service.getStatus()))
  assert.deepEqual(plain(await service.generate(request)), {
    ok: false,
    error: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
  assert.deepEqual(plain(await service.cancel(request.requestId)), {
    cancelled: false,
    reason: 'unsupported'
  })
  await service.dispose()
  assert.deepEqual(plain(service.getStatus()), { state: 'disconnected' })
})

test('Codex IPC accepts bounded explicit request data only from the trusted main frame', () => {
  assert.equal(
    isAllowedAiMailCodexRequest({ ...base, operation: 'generate', args: [request] }),
    true
  )
  for (const changed of [
    { ...base, senderMatches: false },
    { ...base, mainFrameMatches: false },
    { ...base, operation: 'generate', args: [{ ...request, prompt: 'x'.repeat(4001) }] },
    { ...base, operation: 'generate', args: [{ ...request, generation: 0 }] },
    { ...base, operation: 'generate', args: [{ ...request, unexpected: 'extra' }] },
    { ...base, operation: 'cancel', args: ['invalid id'] }
  ])
    assert.equal(isAllowedAiMailCodexRequest(changed), false)
})
