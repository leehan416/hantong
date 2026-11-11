/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Test helper runs in plain JavaScript. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAiMailCodexService } = loadTypeScript(
  new URL('../src/main/ai-mail-codex-service.ts', import.meta.url),
  {
    'node:child_process': {
      spawn: () => {
        throw new Error('unexpected_spawn')
      }
    }
  }
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

async function setup(t, behavior) {
  const root = await mkdtemp(join(tmpdir(), 'hantong-ai-mail-service-'))
  const appDataDirectory = join(root, 'user-data')
  const runtimeDirectory = join(appDataDirectory, 'codex-runtime')
  const executableDirectory = join(runtimeDirectory, 'bin')
  const privateRoot = join(runtimeDirectory, 'home')
  await mkdir(executableDirectory, { recursive: true, mode: 0o700 })
  await mkdir(privateRoot, { mode: 0o700 })
  const executablePath = join(executableDirectory, 'codex')
  await writeFile(executablePath, 'synthetic executable', { mode: 0o700 })
  t.after(() => rm(root, { recursive: true, force: true }))
  const spawned = []
  const openedUrls = []
  const service = createAiMailCodexService({
    executablePath,
    dataRoot: privateRoot,
    appDataDirectory,
    requestTimeoutMs: 1000,
    loginTimeoutMs: 1000,
    spawnProcess: (executable, args, options) => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stdin = new PassThrough()
      child.exitCode = null
      child.signalCode = null
      child.kill = (signal) => {
        child.signalCode = signal
        child.exitCode = signal === 'SIGKILL' ? null : 0
        child.emit('exit', child.exitCode, signal)
        return true
      }
      const writes = []
      child.stdin.on('data', (chunk) => {
        const packet = JSON.parse(String(chunk))
        writes.push(packet)
        behavior({ child, packet, writes })
      })
      spawned.push({ executable, args, options, child, writes })
      queueMicrotask(() => child.emit('spawn'))
      return child
    },
    openExternal: async (url) => {
      openedUrls.push(url)
    }
  })
  return { service, spawned, openedUrls }
}

test('without an explicitly provisioned Hantong executable, Codex stays unsupported', async () => {
  const service = createAiMailCodexService()
  assert.deepEqual(plain(service.getStatus()), {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
  assert.deepEqual(plain(await service.connect()), {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
  assert.deepEqual(plain(await service.generate(request)), {
    ok: false,
    error: 'unauthenticated',
    reason: 'chatgpt_account_not_connected'
  })
  await service.dispose()
  assert.deepEqual(plain(service.getStatus()), {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
})

test('app-server receives only its isolated home, path and disabled tool configuration', async (t) => {
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
  })
  const result = await service.connect()
  assert.equal(result.state, 'error')
  assert.equal(spawned.length, 1)
  const launched = spawned[0]
  assert.equal(launched.executable.endsWith('/codex'), true)
  assert.ok(launched.args.includes('--disable') && launched.args.includes('shell_tool'))
  assert.equal(launched.options.env.HOME, launched.options.env.CODEX_HOME)
  assert.equal(launched.options.env.PATH, '/usr/bin:/bin')
  assert.equal(Object.hasOwn(launched.options.env, 'OPENAI_API_KEY'), false)
  assert.equal(Object.hasOwn(launched.options.env, 'CODEX_API_KEY'), false)
  const isolatedConfig = await readFile(
    join(launched.options.env.CODEX_HOME, 'config.toml'),
    'utf8'
  )
  assert.match(isolatedConfig, /project_doc_max_bytes = 0/)
  assert.match(isolatedConfig, /default_permissions = "hantong-no-local-io"/)
  assert.match(isolatedConfig, /":root" = "deny"/)
  assert.match(isolatedConfig, /enabled = false/)
  assert.deepEqual(plain(await service.generate(request)), {
    ok: false,
    error: 'unauthenticated',
    reason: 'chatgpt_account_not_connected'
  })
  await service.dispose()
})

test('ChatGPT login is opened through the system browser and tool restrictions must verify', async (t) => {
  let loggedIn = false
  const { service, spawned, openedUrls } = await setup(t, ({ child, packet }) => {
    let result = {}
    if (packet.method === 'initialize') result = {}
    if (packet.method === 'account/read')
      result = { account: loggedIn ? { type: 'chatgpt' } : null }
    if (packet.method === 'account/login/start')
      result = { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize', loginId: 'login_1' }
    if (packet.method === 'account/login/start') {
      loggedIn = true
      child.stdout.write(
        `${JSON.stringify({ method: 'account/login/completed', params: { loginId: 'login_1', success: true } })}\n`
      )
    }
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
    if (packet.method === 'experimentalFeature/list') result = { data: [], nextCursor: null }
    if (packet.method === 'mcpServerStatus/list') result = { data: [], nextCursor: null }
    if (packet.method === 'app/installed') result = { apps: [] }
    if (packet.method === 'config/read') result = { config: { project_doc_max_bytes: 0 } }
    if (packet.method === 'thread/start')
      result = {
        thread: { id: 'thread_1' },
        sandbox: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never'
      }
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  await service.connect()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(openedUrls, ['https://auth.openai.com/authorize'])
  assert.deepEqual(plain(service.getStatus()), { state: 'connected' })
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'account/logout'),
    false
  )
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'turn/start'),
    false
  )
  await service.dispose()
})

test('ChatGPT session connects while generation fails closed without a verified tool policy', async (t) => {
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    let result = {}
    if (packet.method === 'initialize') result = {}
    if (packet.method === 'account/read') result = { account: { type: 'chatgpt' } }
    if (packet.method === 'experimentalFeature/list') result = { data: [], nextCursor: null }
    if (packet.method === 'mcpServerStatus/list') result = { data: [], nextCursor: null }
    if (packet.method === 'app/installed') result = { apps: [] }
    if (packet.method === 'config/read') result = { config: { project_doc_max_bytes: 0 } }
    if (packet.method === 'thread/start')
      result = {
        thread: { id: 'thread_1' },
        sandbox: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never'
      }
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  assert.deepEqual(plain(await service.connect()), { state: 'connected' })
  assert.deepEqual(plain(await service.generate(request)), {
    ok: false,
    error: 'unsupported',
    reason: 'tool_restrictions_unverified'
  })
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'turn/start'),
    false
  )
  await service.dispose()
})

test('Codex IPC accepts bounded explicit requests only from the trusted main frame', () => {
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
