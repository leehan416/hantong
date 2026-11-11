/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Test helper runs in plain JavaScript. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const serviceSource = new URL('../src/main/ai-mail-codex-service.ts', import.meta.url)
const childProcessMock = {
  spawn: () => {
    throw new Error('unexpected_spawn')
  }
}
function createServiceFactory(runtimePin) {
  const overrides = { 'node:child_process': childProcessMock }
  if (runtimePin !== undefined) overrides['./codex-runtime-pin'] = { CODEX_RUNTIME_PIN: runtimePin }
  return loadTypeScript(serviceSource, overrides).createAiMailCodexService
}
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

async function setup(t, behavior, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hantong-ai-mail-service-'))
  const appDataDirectory = join(root, 'user-data')
  const resourcesDirectory = join(root, 'Hantong.app', 'Contents', 'Resources')
  const executableDirectory = join(resourcesDirectory, 'codex-runtime', 'bin')
  const legacyExecutableDirectory = join(appDataDirectory, 'codex-runtime', 'bin')
  const privateRoot = join(appDataDirectory, 'codex-runtime', 'home')
  await mkdir(executableDirectory, { recursive: true, mode: 0o700 })
  await mkdir(legacyExecutableDirectory, { recursive: true, mode: 0o700 })
  await mkdir(appDataDirectory, { recursive: true, mode: 0o700 })
  const executablePath = join(executableDirectory, 'codex')
  const legacyExecutablePath = join(legacyExecutableDirectory, 'codex')
  const executableBytes = 'synthetic executable'
  await writeFile(executablePath, executableBytes, { mode: 0o700 })
  await writeFile(legacyExecutablePath, executableBytes, { mode: 0o700 })
  if (options.symlinkExecutable) {
    await unlink(executablePath)
    await symlink(legacyExecutablePath, executablePath)
  }
  const runtimePin = Object.hasOwn(options, 'runtimePin')
    ? options.runtimePin
    : {
        version: '0.167.1',
        target: 'aarch64-apple-darwin',
        executableSha256: createHash('sha256').update(executableBytes).digest('hex')
      }
  t.after(() => rm(root, { recursive: true, force: true }))
  const spawned = []
  const openedUrls = []
  const originalExecutableOverride = process.env['HANTONG_CODEX_EXECUTABLE']
  if (options.environmentOverride) process.env['HANTONG_CODEX_EXECUTABLE'] = legacyExecutablePath
  const service = createServiceFactory(runtimePin)({
    executablePath: options.environmentOverride ? undefined : legacyExecutablePath,
    dataRoot: privateRoot,
    appDataDirectory,
    resourcesDirectory,
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
  if (originalExecutableOverride === undefined) delete process.env['HANTONG_CODEX_EXECUTABLE']
  else process.env['HANTONG_CODEX_EXECUTABLE'] = originalExecutableOverride
  return { service, spawned, openedUrls, executablePath, legacyExecutablePath }
}

test('without an explicitly provisioned Hantong executable, Codex stays unsupported', async () => {
  const service = createServiceFactory()()
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

test('dispose during asynchronous startup prevents a later app-server spawn', async (t) => {
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
  })
  const connecting = service.connect()
  await service.dispose()
  await connecting
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(spawned.length, 0)
})

test('repeated connect during the same pending ChatGPT login owns one flow', async (t) => {
  let loginStarts = 0
  const { service, spawned, openedUrls } = await setup(t, ({ child, packet }) => {
    let result = {}
    if (packet.method === 'account/read') result = { account: null }
    if (packet.method === 'account/login/start') {
      loginStarts += 1
      result = { type: 'chatgpt', authUrl: 'https://auth.openai.com/authorize', loginId: 'login_1' }
    }
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  assert.deepEqual(plain(await service.connect()), {
    state: 'connecting',
    reason: 'awaiting_chatgpt_login'
  })
  assert.deepEqual(plain(await service.connect()), {
    state: 'connecting',
    reason: 'awaiting_chatgpt_login'
  })
  assert.equal(loginStarts, 1)
  assert.deepEqual(openedUrls, ['https://auth.openai.com/authorize'])
  await service.dispose()
  assert.equal(
    spawned[0].writes.filter((packet) => packet.method === 'account/login/cancel').length,
    1
  )
})

test('a packaged runtime whose digest differs from the build pin is never spawned', async (t) => {
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
    },
    {
      runtimePin: {
        version: '0.167.1',
        target: 'aarch64-apple-darwin',
        executableSha256: '0'.repeat(64)
      }
    }
  )
  const result = await service.connect()
  assert.equal(result.state, 'error')
  assert.equal(spawned.length, 0)
  await service.dispose()
})

test('a packaged file without a build-owned executable digest stays unsupported', async (t) => {
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
    },
    { runtimePin: { version: '0.167.1', target: 'aarch64-apple-darwin', executableSha256: null } }
  )
  assert.deepEqual(plain(await service.connect()), {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  })
  assert.equal(spawned.length, 0)
  await service.dispose()
})

test('the packaged runtime path rejects symlink substitution', async (t) => {
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
    },
    { symlinkExecutable: true }
  )
  await service.connect()
  assert.equal(spawned.length, 0)
  await service.dispose()
})

test('the launcher environment cannot replace the packaged Codex executable', async (t) => {
  const { service, spawned, executablePath, legacyExecutablePath } = await setup(
    t,
    ({ child, packet }) => {
      if (packet.method === 'account/read') {
        child.stdout.write(
          `${JSON.stringify({ id: packet.id, result: { account: { type: 'chatgpt' } } })}\n`
        )
        return
      }
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
    },
    { environmentOverride: true }
  )
  await service.connect()
  assert.equal(spawned[0].executable, executablePath)
  assert.notEqual(spawned[0].executable, legacyExecutablePath)
  await service.dispose()
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
