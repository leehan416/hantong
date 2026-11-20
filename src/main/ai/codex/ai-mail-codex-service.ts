import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAppServerTransport, AppServerRpcError } from './app-server-transport'
import {
  createGenerationController,
  redactReason,
  type CodexProcess
} from './generation-controller'
import { CODEX_RUNTIME_PIN, type CodexRuntimePin } from './codex-runtime-pin'
import {
  inspectRuntime,
  hasTrustedRuntimePin,
  verifyExecutableUnchanged,
  verifyPackagedExecutable
} from './runtime-inspection'
import { prepareIsolatedHome } from './isolated-home'
import { APP_SERVER_DISABLE_FEATURES, verifyRestrictions } from './restriction-verification'
import type {
  CodexConnectionStatus,
  CodexGenerationRequest,
  CodexGenerationResult,
  CodexModelInventory
} from '~/shared/ipc'

const APP_SERVER_TIMEOUT_MS = 15_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
type ServiceOptions = {
  resourcesDirectory?: string
  dataRoot?: string
  spawnProcess?: typeof spawn
  openExternal?: (url: string) => Promise<void>
  requestTimeoutMs?: number
  loginTimeoutMs?: number
  platform?: NodeJS.Platform
  appDataDirectory?: string
  onStatus?: (status: CodexConnectionStatus) => void
}
type LoginFlow = {
  id: string
  generation: number
  timer: NodeJS.Timeout
  poll: NodeJS.Timeout
  completion?: Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validatedAuthUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && ['auth.openai.com', 'chatgpt.com'].includes(url.hostname)
  } catch {
    return false
  }
}

export function createAiMailCodexService(options: ServiceOptions = {}): {
  getStatus: () => CodexConnectionStatus
  getModels: () => Promise<CodexModelInventory>
  connect: () => Promise<CodexConnectionStatus>
  disconnect: () => Promise<CodexConnectionStatus>
  generate: (request: CodexGenerationRequest) => Promise<CodexGenerationResult>
  cancel: (requestId: string) => Promise<{ cancelled: boolean; reason?: string }>
  dispose: () => Promise<void>
} {
  const platform = options.platform ?? process.platform
  const appDataDirectory = options.appDataDirectory
  const resourcesDirectory =
    options.resourcesDirectory ??
    (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const dataRoot = resolve(
    options.dataRoot ??
      (appDataDirectory
        ? join(appDataDirectory, 'codex-runtime', 'home')
        : join(tmpdir(), 'hantong-ai-mail'))
  )
  const runtimePin: CodexRuntimePin = CODEX_RUNTIME_PIN
  const { executablePath, executableRoot, runtimeDirectory } = inspectRuntime(resourcesDirectory)
  const spawnProcess = options.spawnProcess ?? spawn
  const requestTimeoutMs = options.requestTimeoutMs ?? APP_SERVER_TIMEOUT_MS
  const loginTimeoutMs = options.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
  let status: CodexConnectionStatus = {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  }
  let runtime: CodexProcess | null = null
  let login: LoginFlow | null = null
  let disposed = false
  let lifecycleGeneration = 0
  let lifecycle: Promise<CodexConnectionStatus> | null = null
  function isCurrent(generation: number): boolean {
    return !disposed && lifecycleGeneration === generation
  }

  function assertCurrent(generation: number): void {
    if (!isCurrent(generation)) throw new Error('service_stale')
  }

  function setStatus(next: CodexConnectionStatus): void {
    if (JSON.stringify(status) === JSON.stringify(next)) return
    status = next
    options.onStatus?.(next)
  }

  function failPending(processState: CodexProcess, reason: string): void {
    processState.transport.failPending(reason)
  }

  const generationController = createGenerationController({
    requestTimeoutMs,
    rpc,
    stopProcess
  })

  function onNotification(processState: CodexProcess, packet: Record<string, unknown>): void {
    if (processState.closed) return
    if (
      typeof packet['method'] === 'string' &&
      packet['params'] &&
      typeof packet['params'] === 'object'
    ) {
      processState.notifications.push({
        method: packet['method'],
        params: packet['params'] as Record<string, unknown>
      })
      generationController.handleNotification(processState, packet)
      if (processState.notifications.length > 100) processState.notifications.shift()
    }
  }

  function rpc(processState: CodexProcess, method: string, params: unknown = {}): Promise<unknown> {
    return processState.transport.request(method, params)
  }

  function stopProcess(processState: CodexProcess): Promise<boolean> {
    if (processState.stopPromise) return processState.stopPromise
    const stopping = (async () => {
      processState.closed = true
      processState.transport.markClosed()
      failPending(processState, 'app_server_closed')
      generationController.prepareProcessStop(processState)
      processState.child.stdin?.end()
      if (processState.child.exitCode === null && processState.child.signalCode === null) {
        const exited = new Promise<void>((resolvePromise) =>
          processState.child.once('exit', () => resolvePromise())
        )
        const timeout = setTimeout(() => processState.child.kill('SIGTERM'), 300)
        let hardTimeout: NodeJS.Timeout | undefined
        await Promise.race([
          exited,
          new Promise<void>((resolvePromise) => {
            hardTimeout = setTimeout(resolvePromise, 700)
          })
        ])
        clearTimeout(timeout)
        if (hardTimeout) clearTimeout(hardTimeout)
        if (processState.child.exitCode === null && processState.child.signalCode === null) {
          processState.child.kill('SIGKILL')
          await Promise.race([
            exited,
            new Promise<void>((resolvePromise) => {
              hardTimeout = setTimeout(resolvePromise, 500)
            })
          ])
          if (hardTimeout) clearTimeout(hardTimeout)
        }
      }
      const confirmed =
        processState.child.exitCode !== null || processState.child.signalCode !== null
      if (runtime === processState && confirmed) runtime = null
      if (!confirmed && runtime === processState)
        setStatus({ state: 'error', reason: 'process_stop_unconfirmed' })
      generationController.finishProcessStop(processState, confirmed)
      return confirmed
    })()
    processState.stopPromise = stopping
    return stopping
  }

  async function startProcess(generation: number): Promise<CodexProcess> {
    assertCurrent(generation)
    if (
      !resourcesDirectory ||
      !executablePath ||
      !executableRoot ||
      !runtimeDirectory ||
      !hasTrustedRuntimePin(runtimePin)
    )
      throw new Error('product_owned_executable_unavailable')
    if (platform !== 'darwin' || process.arch !== 'arm64')
      throw new Error('product_owned_executable_unavailable')
    const executableIdentity = await verifyPackagedExecutable(
      resourcesDirectory,
      runtimeDirectory,
      executableRoot,
      executablePath,
      runtimePin,
      () => assertCurrent(generation)
    )
    const { home, workspace } = await prepareIsolatedHome(dataRoot)
    assertCurrent(generation)
    const restrictedEnv: NodeJS.ProcessEnv = {
      CODEX_HOME: home,
      HOME: home,
      PATH: '/usr/bin:/bin',
      TMPDIR: tmpdir(),
      LANG: 'en_US.UTF-8',
      TERM: 'dumb'
    }
    const args = ['app-server', '--listen', 'stdio://', '--enable', 'skip_host_skill_discovery']
    for (const feature of APP_SERVER_DISABLE_FEATURES) args.push('--disable', feature)
    await verifyExecutableUnchanged(executablePath, executableIdentity)
    assertCurrent(generation)
    const child = spawnProcess(executablePath, args, {
      cwd: workspace,
      env: restrictedEnv,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const processState: CodexProcess = {
      child,
      transport: createAppServerTransport(
        child,
        requestTimeoutMs,
        (packet) => onNotification(processState, packet),
        (fatal) => {
          generationController.failProcess(processState, 'invalid_protocol')
          if (fatal) void stopProcess(processState)
        }
      ),
      notifications: [],
      closed: false,
      home,
      workspace,
      generation,
      readiness: false,
      threads: new Map(),
      activeTurns: new Map()
    }
    runtime = processState
    child.on('error', () => {
      failPending(processState, 'app_server_process_failed')
      generationController.failProcess(processState, 'app_server_process_failed')
    })
    child.on('exit', () => {
      const wasClosing = processState.closed
      if (login?.generation === processState.generation) cleanLogin()
      failPending(processState, 'app_server_process_exited')
      generationController.failProcess(processState, 'app_server_process_exited', true)
      processState.closed = true
      processState.transport.markClosed()
      if (runtime === processState) {
        runtime = null
        if (!wasClosing) setStatus({ state: 'error', reason: 'app_server_process_exited' })
      }
    })
    try {
      await rpc(processState, 'initialize', {
        clientInfo: { name: 'hantong', title: 'Hantong', version: '0.1.0' },
        capabilities: { experimentalApi: false }
      })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`
      )
      assertCurrent(generation)
      return processState
    } catch (error) {
      await stopProcess(processState)
      throw error
    }
  }

  function cleanLogin(): void {
    if (!login) return
    clearTimeout(login.timer)
    clearInterval(login.poll)
    login = null
  }

  function clearLoginTimers(flow: LoginFlow): void {
    clearTimeout(flow.timer)
    clearInterval(flow.poll)
  }

  async function readAccount(processState: CodexProcess): Promise<{ type?: string } | null> {
    const response = (await rpc(processState, 'account/read', { refreshToken: false })) as {
      account?: { type?: string } | null
    }
    return response.account ?? null
  }

  function verifyProcessRestrictions(processState: CodexProcess): Promise<boolean> {
    return verifyRestrictions(processState, (method, params) => rpc(processState, method, params))
  }

  async function getModels(): Promise<CodexModelInventory> {
    const processState = runtime
    if (disposed || status.state !== 'connected' || !processState)
      return { state: 'unavailable', reason: 'not_connected' }
    try {
      const models: import('~/shared/ipc').CodexModel[] = []
      let cursor: string | null = null
      const seenCursors = new Set<string>()
      for (let page = 0; page < 4; page += 1) {
        const result = await rpc(processState, 'model/list', {
          limit: 100,
          cursor,
          includeHidden: false
        })
        if (!isRecord(result) || !Array.isArray(result.data) || result.data.length > 100)
          throw new Error('invalid_model_catalog')
        for (const item of result.data) {
          if (!isRecord(item) || item.hidden === true) continue
          const id = typeof item.id === 'string' ? item.id : ''
          const model = typeof item.model === 'string' ? item.model : id
          const displayName = typeof item.displayName === 'string' ? item.displayName : id
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(id) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(model) ||
            displayName.length === 0 ||
            displayName.length > 128 ||
            (Array.isArray(item.inputModalities) && !item.inputModalities.includes('text'))
          )
            continue
          models.push({ id, model, displayName })
        }
        if (result.nextCursor === null || result.nextCursor === undefined)
          return { state: 'available', models }
        if (
          typeof result.nextCursor !== 'string' ||
          result.nextCursor.length > 256 ||
          seenCursors.has(result.nextCursor)
        )
          throw new Error('invalid_model_cursor')
        cursor = result.nextCursor
        seenCursors.add(cursor)
      }
      if (cursor !== null) throw new Error('model_catalog_page_limit')
      return { state: 'available', models }
    } catch {
      return { state: 'unavailable', reason: 'discovery_failed' }
    }
  }

  async function completeLogin(processState: CodexProcess, flow: LoginFlow): Promise<void> {
    if (login !== flow || !isCurrent(flow.generation)) return
    const completed = processState.notifications.some(
      (notification) =>
        notification.method === 'account/login/completed' &&
        notification.params['loginId'] === flow.id &&
        notification.params['success'] === true
    )
    if (!completed) return
    if (flow.completion) return flow.completion
    clearLoginTimers(flow)
    flow.completion = (async () => {
      try {
        const account = await readAccount(processState)
        if (!isCurrent(flow.generation) || login !== flow) return
        if (account?.type !== 'chatgpt') {
          await rpc(processState, 'account/logout').catch(() => undefined)
          if (isCurrent(flow.generation)) {
            setStatus({ state: 'error', reason: 'chatgpt_account_required' })
            await stopProcess(processState)
          }
          return
        }
        setStatus({ state: 'connected' })
        void verifyProcessRestrictions(processState)
      } catch {
        await rpc(processState, 'account/logout').catch(() => undefined)
        if (isCurrent(flow.generation)) {
          setStatus({ state: 'error', reason: 'connection_failed' })
          await stopProcess(processState)
        }
      } finally {
        clearLoginTimers(flow)
        if (login === flow) login = null
      }
    })()
    return flow.completion
  }

  async function connect(): Promise<CodexConnectionStatus> {
    if (disposed) return { state: 'error', reason: 'service_disposed' }
    if (!executablePath || !hasTrustedRuntimePin(runtimePin)) return status
    if (lifecycle) return lifecycle
    if (login) return status
    const generation = lifecycleGeneration
    const attempt = (async () => {
      setStatus({ state: 'connecting' })
      try {
        const processState = runtime ?? (await startProcess(generation))
        assertCurrent(generation)
        const account = await readAccount(processState)
        assertCurrent(generation)
        if (account?.type === 'chatgpt') {
          setStatus({ state: 'connected' })
          void verifyProcessRestrictions(processState)
          return status
        }
        const result = (await rpc(processState, 'account/login/start', {
          type: 'chatgpt',
          codexStreamlinedLogin: true
        })) as { type?: string; authUrl?: unknown; loginId?: string }
        if (!isCurrent(generation)) {
          if (typeof result.loginId === 'string')
            await rpc(processState, 'account/login/cancel', { loginId: result.loginId }).catch(
              () => undefined
            )
          return status
        }
        if (
          result.type !== 'chatgpt' ||
          !validatedAuthUrl(result.authUrl) ||
          typeof result.loginId !== 'string'
        )
          throw new Error('unexpected_login_response')
        const opener = options.openExternal
        if (!opener) throw new Error('system_browser_unavailable')
        setStatus({ state: 'connecting', reason: 'awaiting_chatgpt_login' })
        const loginId = result.loginId
        const flowHolder: { value?: LoginFlow } = {}
        const timer = setTimeout(() => {
          const flow = flowHolder.value
          if (!flow || login !== flow || !isCurrent(generation)) return
          const cleanupGeneration = ++lifecycleGeneration
          cleanLogin()
          const cleanup = (async () => {
            await rpc(processState, 'account/login/cancel', { loginId }).catch(() => undefined)
            if (runtime === processState) await stopProcess(processState)
            if (isCurrent(cleanupGeneration))
              setStatus({ state: 'error', reason: 'login_timed_out' })
            return status
          })()
          const trackedCleanup = cleanup.finally(() => {
            if (lifecycle === trackedCleanup) lifecycle = null
          })
          lifecycle = trackedCleanup
        }, loginTimeoutMs)
        const poll = setInterval(() => {
          const flow = flowHolder.value
          if (flow) void completeLogin(processState, flow)
        }, 200)
        const flow: LoginFlow = { id: loginId, generation, timer, poll }
        flowHolder.value = flow
        login = flow
        await opener(result.authUrl)
        if (!isCurrent(generation) || login !== flow) {
          clearLoginTimers(flow)
          await rpc(processState, 'account/login/cancel', { loginId }).catch(() => undefined)
          return status
        }
        await completeLogin(processState, flow)
        return status
      } catch (error) {
        if (!isCurrent(generation)) return status
        const failedLogin = login?.generation === generation ? login : null
        if (failedLogin) {
          cleanLogin()
          if (runtime)
            await rpc(runtime, 'account/login/cancel', { loginId: failedLogin.id }).catch(
              () => undefined
            )
        }
        const message = error instanceof Error ? error.message : ''
        if (message === 'product_owned_executable_unavailable') {
          setStatus({ state: 'unsupported', reason: 'product_owned_executable_unavailable' })
          return status
        }
        setStatus({
          state: 'error',
          reason: redactReason(
            message,
            error instanceof AppServerRpcError ? error.category : undefined
          )
        })
        if (runtime && status.state === 'error') await stopProcess(runtime)
        return status
      }
    })()
    const trackedAttempt = attempt.finally(() => {
      if (lifecycle === trackedAttempt) lifecycle = null
    })
    lifecycle = trackedAttempt
    return trackedAttempt
  }

  return {
    getStatus: (): CodexConnectionStatus => status,
    getModels,
    connect,
    disconnect: async (): Promise<CodexConnectionStatus> => {
      lifecycleGeneration += 1
      const pendingLogin = login
      cleanLogin()
      const processState = runtime
      if (processState) {
        if (pendingLogin)
          await rpc(processState, 'account/login/cancel', { loginId: pendingLogin.id }).catch(
            () => undefined
          )
        await rpc(processState, 'account/logout').catch(() => undefined)
        await stopProcess(processState)
      }
      setStatus(
        executablePath && hasTrustedRuntimePin(runtimePin)
          ? { state: 'disconnected' }
          : { state: 'unsupported', reason: 'product_owned_executable_unavailable' }
      )
      return status
    },
    generate: async (request: CodexGenerationRequest): Promise<CodexGenerationResult> => {
      return generationController.generate(request, runtime, status.state === 'connected')
    },
    cancel: async (requestId: string): Promise<{ cancelled: boolean; reason?: string }> => {
      return generationController.cancel(requestId)
    },
    dispose: async (): Promise<void> => {
      disposed = true
      lifecycleGeneration += 1
      const pendingLogin = login
      cleanLogin()
      if (runtime) {
        const processState = runtime
        if (pendingLogin)
          await rpc(processState, 'account/login/cancel', { loginId: pendingLogin.id }).catch(
            () => undefined
          )
        await stopProcess(processState)
      }
      setStatus(
        executablePath && hasTrustedRuntimePin(runtimePin)
          ? { state: 'disconnected' }
          : { state: 'unsupported', reason: 'product_owned_executable_unavailable' }
      )
    }
  }
}
