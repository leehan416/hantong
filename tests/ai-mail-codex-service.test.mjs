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
function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

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
    loginTimeoutMs: options.loginTimeoutMs ?? 1000,
    spawnProcess: (executable, args, options) => {
      const child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stdin = new PassThrough()
      child.exitCode = null
      child.signalCode = null
      child.killSignals = []
      child.deferExitOnKill = options.deferExitOnKill === true
      child.finishExit = (signal = child.signalCode ?? 'SIGTERM') => {
        child.signalCode = signal
        child.exitCode = signal === 'SIGKILL' ? null : 0
        child.emit('exit', child.exitCode, signal)
        child.emit('close', child.exitCode, signal)
      }
      child.kill = (signal) => {
        child.killSignals.push(signal)
        child.emit('killed', signal)
        if (child.deferExitOnKill) {
          return true
        }
        child.signalCode = signal
        child.exitCode = signal === 'SIGKILL' ? null : 0
        child.emit('exit', child.exitCode, signal)
        child.emit('close', child.exitCode, signal)
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

test('login timeout serializes reconnect and allows retry only after its runtime stops', async (t) => {
  let loginStarts = 0
  let timeoutCancel
  const cancelSeen = deferred()
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      let result = {}
      if (packet.method === 'account/read') result = { account: null }
      if (packet.method === 'account/login/start') {
        loginStarts += 1
        result = {
          type: 'chatgpt',
          authUrl: 'https://auth.openai.com/authorize',
          loginId: `login_${loginStarts}`
        }
      }
      if (packet.method === 'account/login/cancel' && !timeoutCancel) {
        timeoutCancel = { child, packet }
        cancelSeen.resolve()
        return
      }
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
    },
    { loginTimeoutMs: 10 }
  )
  try {
    await service.connect()
    await cancelSeen.promise
    let reconnectSettled = false
    const reconnect = service.connect().then((result) => {
      reconnectSettled = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(reconnectSettled, false)
    assert.equal(loginStarts, 1)
    assert.equal(spawned.length, 1)
    timeoutCancel.child.stdout.write(
      `${JSON.stringify({ id: timeoutCancel.packet.id, result: {} })}\n`
    )
    assert.deepEqual(plain(await reconnect), { state: 'error', reason: 'login_timed_out' })
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].child.killSignals.filter((signal) => signal === 'SIGTERM').length, 1)
    assert.deepEqual(plain(await service.connect()), {
      state: 'connecting',
      reason: 'awaiting_chatgpt_login'
    })
    assert.equal(loginStarts, 2)
    assert.equal(spawned.length, 2)
  } finally {
    await service.dispose()
  }
})

test('disconnect during timeout cleanup stays disconnected after late cancel completion', async (t) => {
  let timeoutCancel
  const cancelSeen = deferred()
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      let result = {}
      if (packet.method === 'account/read') result = { account: null }
      if (packet.method === 'account/login/start')
        result = {
          type: 'chatgpt',
          authUrl: 'https://auth.openai.com/authorize',
          loginId: 'login_1'
        }
      if (packet.method === 'account/login/cancel' && !timeoutCancel) {
        timeoutCancel = { child, packet }
        cancelSeen.resolve()
        return
      }
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
    },
    { loginTimeoutMs: 10 }
  )
  try {
    await service.connect()
    await cancelSeen.promise
    const retryDuringCleanup = service.connect()
    const disconnected = service.disconnect()
    assert.deepEqual(plain(await disconnected), { state: 'disconnected' })
    timeoutCancel.child.stdout.write(
      `${JSON.stringify({ id: timeoutCancel.packet.id, result: {} })}\n`
    )
    await retryDuringCleanup
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(plain(service.getStatus()), { state: 'disconnected' })
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].child.killSignals.filter((signal) => signal === 'SIGTERM').length, 1)
  } finally {
    await service.dispose()
  }
})

test('dispose during timeout cleanup ignores a late RPC response and keeps disposed state', async (t) => {
  let timeoutCancel
  const cancelSeen = deferred()
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      let result = {}
      if (packet.method === 'account/read') result = { account: null }
      if (packet.method === 'account/login/start')
        result = {
          type: 'chatgpt',
          authUrl: 'https://auth.openai.com/authorize',
          loginId: 'login_1'
        }
      if (packet.method === 'account/login/cancel' && !timeoutCancel) {
        timeoutCancel = { child, packet }
        cancelSeen.resolve()
        return
      }
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
    },
    { loginTimeoutMs: 10 }
  )
  try {
    await service.connect()
    await cancelSeen.promise
    const waitingConnect = service.connect()
    await service.dispose()
    timeoutCancel.child.stdout.write(
      `${JSON.stringify({ id: timeoutCancel.packet.id, result: {} })}\n`
    )
    await waitingConnect
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(plain(service.getStatus()), { state: 'disconnected' })
    assert.deepEqual(plain(await service.connect()), { state: 'error', reason: 'service_disposed' })
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].child.killSignals.filter((signal) => signal === 'SIGTERM').length, 1)
  } finally {
    await service.dispose()
  }
})

test('timeout reconnect waits for deferred exit after cancel RPC rejection', async (t) => {
  let cancelSeen
  const cancelStarted = deferred()
  const { service, spawned } = await setup(
    t,
    ({ child, packet }) => {
      let result = {}
      if (packet.method === 'account/read') result = { account: null }
      if (packet.method === 'account/login/start')
        result = {
          type: 'chatgpt',
          authUrl: 'https://auth.openai.com/authorize',
          loginId: 'login_1'
        }
      if (packet.method === 'account/login/cancel') {
        cancelSeen = { child, packet }
        cancelStarted.resolve()
        child.stdout.write(
          `${JSON.stringify({
            id: packet.id,
            error: { message: 'synthetic cancel rejection', data: { type: 'rejected' } }
          })}\n`
        )
        return
      }
      if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
    },
    { loginTimeoutMs: 10, deferExitOnKill: true }
  )
  try {
    await service.connect()
    await cancelStarted.promise
    const killed = deferred()
    spawned[0].child.once('killed', killed.resolve)
    let reconnectSettled = false
    const reconnect = service.connect().then((result) => {
      reconnectSettled = true
      return result
    })
    await killed.promise
    assert.deepEqual(spawned[0].child.killSignals, ['SIGTERM'])
    assert.equal(reconnectSettled, false)
    assert.equal(spawned.length, 1)
    assert.equal(cancelSeen.child, spawned[0].child)
    spawned[0].child.finishExit('SIGTERM')
    assert.deepEqual(plain(await reconnect), { state: 'error', reason: 'login_timed_out' })
    assert.deepEqual(plain(service.getStatus()), { state: 'error', reason: 'login_timed_out' })
    await new Promise((resolve) => setTimeout(resolve, 750))
    assert.deepEqual(spawned[0].child.killSignals, ['SIGTERM'])
    assert.deepEqual(plain(await service.connect()), {
      state: 'connecting',
      reason: 'awaiting_chatgpt_login'
    })
    assert.equal(spawned.length, 2)
  } finally {
    await service.dispose()
  }
})

for (const action of ['disconnect', 'dispose']) {
  test(`${action} stays authoritative while timeout cleanup waits for deferred exit`, async (t) => {
    const cancelSeen = deferred()
    const { service, spawned } = await setup(
      t,
      ({ child, packet }) => {
        let result = {}
        if (packet.method === 'account/read') result = { account: null }
        if (packet.method === 'account/login/start')
          result = {
            type: 'chatgpt',
            authUrl: 'https://auth.openai.com/authorize',
            loginId: 'login_1'
          }
        if (packet.method === 'account/login/cancel') {
          cancelSeen.resolve()
          return
        }
        if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
      },
      { loginTimeoutMs: 10, deferExitOnKill: true }
    )
    try {
      await service.connect()
      await cancelSeen.promise
      const killed = deferred()
      spawned[0].child.once('killed', killed.resolve)
      const actionPromise = action === 'disconnect' ? service.disconnect() : service.dispose()
      let actionSettled = false
      void actionPromise.then(() => {
        actionSettled = true
      })
      await killed.promise
      assert.equal(actionSettled, false)
      assert.equal(spawned.length, 1)
      assert.deepEqual(spawned[0].child.killSignals, ['SIGTERM'])
      spawned[0].child.finishExit('SIGTERM')
      await actionPromise
      await new Promise((resolve) => setTimeout(resolve, 750))
      assert.deepEqual(plain(service.getStatus()), { state: 'disconnected' })
      assert.deepEqual(spawned[0].child.killSignals, ['SIGTERM'])
      if (action === 'dispose')
        assert.deepEqual(plain(await service.connect()), {
          state: 'error',
          reason: 'service_disposed'
        })
    } finally {
      await service.dispose()
    }
  })
}

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
    if (packet.method === 'config/read')
      result = { config: { project_doc_max_bytes: 0, default_permissions: 'hantong-no-local-io' } }
    if (packet.method === 'permissionProfile/list')
      result = { data: [{ id: 'hantong-no-local-io', allowed: true }], nextCursor: null }
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
    if (packet.method === 'config/read')
      result = { config: { project_doc_max_bytes: 0, default_permissions: 'hantong-no-local-io' } }
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

test('verified synthetic policy permits bounded app-server turns and fences cancellation', async (t) => {
  const toolFeatures = [
    'shell_tool',
    'unified_exec_tty',
    'computer_use',
    'browser_use',
    'browser_use_external',
    'in_app_browser',
    'image_generation',
    'view_image',
    'apps',
    'plugins',
    'skill_search',
    'multi_agent',
    'multi_agent_v2',
    'code_mode',
    'standalone_web_search',
    'web_search_request',
    'web_search_cached',
    'shell_snapshot',
    'shell_snapshot_v2',
    'skill_mcp_dependency_install',
    'request_permissions_tool'
  ]
  toolFeatures.push('unified_exec')
  toolFeatures.push('skip_host_skill_discovery')
  let finishTurn
  let nextDelta = '한국어 답변'
  let interruptBehavior = 'ack'
  let deferTurnStart = false
  let deferredTurnStartId
  let nativeProbe = 0
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    let result = {}
    if (packet.method === 'account/read') result = { account: { type: 'chatgpt' } }
    if (packet.method === 'experimentalFeature/list')
      result = {
        data: toolFeatures.map((name) => ({
          name,
          enabled: name === 'unified_exec' || name === 'skip_host_skill_discovery'
        })),
        nextCursor: null
      }
    if (packet.method === 'mcpServerStatus/list') result = { data: [], nextCursor: null }
    if (packet.method === 'app/installed') result = { apps: [] }
    if (packet.method === 'config/read')
      result = { config: { project_doc_max_bytes: 0, default_permissions: 'hantong-no-local-io' } }
    if (packet.method === 'permissionProfile/list')
      result = { data: [{ id: 'hantong-no-local-io', allowed: true }], nextCursor: null }
    if (packet.method === 'thread/start')
      result = {
        thread: { id: 'thread_safe' },
        sandbox: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never',
        activePermissionProfile: 'hantong-no-local-io'
      }
    if (packet.method === 'turn/start') {
      result = { turn: { id: 'turn_safe' } }
      if (deferTurnStart) {
        deferTurnStart = false
        deferredTurnStartId = packet.id
      }
      finishTurn = () => {
        const delta = Buffer.from(
          `${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread_safe', turnId: 'turn_safe', itemId: 'item_safe', delta: nextDelta } })}\n`
        )
        const split = delta.indexOf(Buffer.from('한')) + 1
        child.stdout.write(delta.subarray(0, split))
        child.stdout.write(delta.subarray(split))
        child.stdout.write(
          `${JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread_safe', turnId: 'turn_safe', tokenUsage: { last: { inputTokens: 12, outputTokens: 4 } } } })}\n`
        )
        child.stdout.write(
          `${JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread_safe', turn: { id: 'turn_safe', status: 'completed', items: [] } } })}\n`
        )
      }
    }
    if (packet.method === 'command/exec') {
      const command = packet.params.command
      nativeProbe += 1
      if (nativeProbe === 1)
        result = { exitCode: 0, stdout: 'HANTONG_READONLY_CONTROL\n', stderr: '' }
      else if (nativeProbe === 2) {
        const nonce = command[1].match(/\.hantong-policy-([a-f0-9]+)\.txt$/)?.[1]
        result = { exitCode: 0, stdout: `HANTONG_ALLOWED_${nonce}\n`, stderr: '' }
      } else result = { exitCode: 1, stdout: '', stderr: 'Operation not permitted' }
    }
    if (packet.method === 'turn/interrupt') {
      if (interruptBehavior === 'reject')
        child.stdout.write(
          `${JSON.stringify({ id: packet.id, error: { message: 'interrupt rejected' } })}\n`
        )
      else if (interruptBehavior === 'ack')
        child.stdout.write(`${JSON.stringify({ id: packet.id, result: {} })}\n`)
    }
    if (
      packet.id &&
      packet.id !== deferredTurnStartId &&
      !(packet.method === 'turn/interrupt' && interruptBehavior !== 'ack')
    )
      child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  await service.connect()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const generation = service.generate(request)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'turn/start'),
    true
  )
  finishTurn()
  assert.deepEqual(plain(await generation), {
    ok: true,
    text: '한국어 답변',
    usage: { inputTokens: 12, outputTokens: 4 }
  })
  deferTurnStart = true
  const pending = service.generate({ ...request, requestId: 'request_cancel', generation: 2 })
  for (let attempt = 0; attempt < 50 && deferredTurnStartId === undefined; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.notEqual(deferredTurnStartId, undefined)
  let cancellationSettled = false
  const cancellation = service.cancel('request_cancel').then((result) => {
    cancellationSettled = true
    return result
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(cancellationSettled, false)
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'turn/interrupt'),
    false
  )
  spawned[0].child.deferExitOnKill = true
  interruptBehavior = 'hang'
  spawned[0].child.stdout.write(
    `${JSON.stringify({ id: deferredTurnStartId, result: { turn: { id: 'turn_safe' } } })}\n`
  )
  assert.deepEqual(plain(await cancellation), {
    cancelled: false,
    reason: 'interrupt_unconfirmed'
  })
  assert.deepEqual(plain(await pending), {
    ok: false,
    error: 'failed',
    reason: 'process_stop_unconfirmed'
  })
  // A late completion from the stopped owned process cannot change the result.
  finishTurn()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(
    spawned[0].writes.some((packet) => packet.method === 'turn/interrupt'),
    true
  )
  assert.equal(spawned[0].child.exitCode, null)
  assert.equal(spawned[0].child.signalCode, null)
  assert.deepEqual(plain(service.getStatus()), {
    state: 'error',
    reason: 'process_stop_unconfirmed'
  })
  const turnStartsBeforeReuse = spawned[0].writes.filter(
    (packet) => packet.method === 'turn/start'
  ).length
  assert.deepEqual(
    plain(
      await service.generate({ ...request, requestId: 'after_unconfirmed_stop', generation: 3 })
    ),
    { ok: false, error: 'unauthenticated', reason: 'chatgpt_account_not_connected' }
  )
  assert.equal(
    spawned[0].writes.filter((packet) => packet.method === 'turn/start').length,
    turnStartsBeforeReuse
  )
  await service.dispose()
})

test('oversized delta is rejected before output concatenation', async (t) => {
  const toolFeatures = [
    'shell_tool',
    'unified_exec_tty',
    'computer_use',
    'browser_use',
    'browser_use_external',
    'in_app_browser',
    'image_generation',
    'view_image',
    'apps',
    'plugins',
    'skill_search',
    'multi_agent',
    'multi_agent_v2',
    'code_mode',
    'standalone_web_search',
    'web_search_request',
    'web_search_cached',
    'shell_snapshot',
    'shell_snapshot_v2',
    'skill_mcp_dependency_install',
    'request_permissions_tool',
    'unified_exec'
  ]
  let sendDelta
  let probes = 0
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    let result = {}
    if (packet.method === 'account/read') result = { account: { type: 'chatgpt' } }
    if (packet.method === 'experimentalFeature/list')
      result = {
        data: toolFeatures.map((name) => ({ name, enabled: name === 'unified_exec' })),
        nextCursor: null
      }
    if (packet.method === 'mcpServerStatus/list') result = { data: [], nextCursor: null }
    if (packet.method === 'app/installed') result = { apps: [] }
    if (packet.method === 'config/read')
      result = { config: { project_doc_max_bytes: 0, default_permissions: 'hantong-no-local-io' } }
    if (packet.method === 'permissionProfile/list')
      result = { data: [{ id: 'hantong-no-local-io', allowed: true }], nextCursor: null }
    if (packet.method === 'thread/start')
      result = {
        thread: { id: 'thread_delta' },
        sandbox: { type: 'readOnly', networkAccess: false },
        approvalPolicy: 'never'
      }
    if (packet.method === 'command/exec') {
      probes += 1
      result =
        probes === 1
          ? { exitCode: 0, stdout: 'HANTONG_READONLY_CONTROL\n' }
          : probes === 2
            ? {
                exitCode: 0,
                stdout: `HANTONG_ALLOWED_${packet.params.command[1].match(/\.hantong-policy-([a-f0-9]+)\.txt$/)?.[1]}\n`
              }
            : { exitCode: 1, stdout: '' }
    }
    if (packet.method === 'turn/start') {
      result = { turn: { id: 'turn_delta' } }
      sendDelta = () =>
        child.stdout.write(
          `${JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread_delta', turnId: 'turn_delta', delta: 'x'.repeat(20_001) } })}\n`
        )
    }
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  await service.connect()
  await new Promise((resolve) => setTimeout(resolve, 30))
  const generation = service.generate(request)
  for (let attempt = 0; attempt < 50 && !sendDelta; attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(typeof sendDelta, 'function')
  sendDelta()
  assert.deepEqual(plain(await generation), {
    ok: false,
    error: 'failed',
    reason: 'response_too_large'
  })
  assert.equal(spawned[0].child.exitCode !== null || spawned[0].child.signalCode !== null, true)
  await service.dispose()
})

test('readiness rejects unknown enabled capabilities', async (t) => {
  const { service } = await setup(t, ({ child, packet }) => {
    const result =
      packet.method === 'account/read'
        ? { account: { type: 'chatgpt' } }
        : packet.method === 'experimentalFeature/list'
          ? { data: [{ name: 'future_shell_backend', enabled: true }], nextCursor: null }
          : {}
    if (packet.id) child.stdout.write(`${JSON.stringify({ id: packet.id, result })}\n`)
  })
  assert.deepEqual(plain(await service.connect()), { state: 'connected' })
  assert.deepEqual(plain(await service.generate(request)), {
    ok: false,
    error: 'unsupported',
    reason: 'tool_restrictions_unverified'
  })
  await service.dispose()
})

test('an oversized single protocol chunk fails closed before parsing', async (t) => {
  const { service, spawned } = await setup(t, ({ child, packet }) => {
    if (packet.method === 'initialize') child.stdout.write('x'.repeat(300_000))
  })
  await service.connect()
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(
    spawned[0].child.killSignals.includes('SIGTERM') ||
      spawned[0].child.killSignals.includes('SIGKILL'),
    true
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
