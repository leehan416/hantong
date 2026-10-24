/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const runtimeModule = loadTypeScript(
  new URL('../src/main/google-connection-runtime.ts', import.meta.url)
)
const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
const code = { code: 'code', verifier: 'verifier', redirectUri: 'http://127.0.0.1:12345/' }
const tokens = {
  accessToken: 'secret-access',
  refreshToken: 'secret-refresh',
  expiresAt: 1900000000000
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fixture(overrides = {}) {
  const calls = { authorization: 0, accept: 0, disconnect: 0 }
  const state = { status: 'connected' }
  const manager = {
    getStatus: async () => ({ status: state.status }),
    acceptConnection: async () => {
      calls.accept += 1
      state.status = 'connected'
      return { status: 'connected', emailAddress: 'private@example.com' }
    },
    ...overrides.manager,
    disconnect:
      overrides.manager?.disconnect ??
      (async () => {
        calls.disconnect += 1
        state.status = 'disconnected'
      })
  }
  const runtime = runtimeModule.createGoogleConnectionRuntime({
    accountExists: () => true,
    readWebIdentity: async () => ({ accountExists: true, emailAddress: 'private@example.com' }),
    loadConfig: () => ({ clientId: 'desktop.apps.googleusercontent.com' }),
    startAuthorization: () => {
      calls.authorization += 1
      return { result: Promise.resolve(code), cancel: () => undefined }
    },
    exchangeCode: async () => tokens,
    fetchProfile: async () => 'private@example.com',
    ...overrides,
    manager
  })
  return { runtime, calls, state, manager }
}

test('runtime status DTO contains only account ID and safe status', async () => {
  const f = fixture()
  const result = await f.runtime.getStatus(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'connected' })
  assert.deepEqual(Object.keys(result).sort(), ['accountId', 'status'])
  assert.equal(JSON.stringify(result).includes('private@example.com'), false)
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('connection lifecycle hook runs only after accepted connection and disconnect hook runs immediately', async () => {
  const hooks = []
  const f = fixture({
    onConnected: (id, result) => hooks.push(['connected', id, result.emailAddress]),
    onDisconnected: (id) => hooks.push(['disconnected', id])
  })
  assert.equal((await f.runtime.connect(accountId)).status, 'connected')
  assert.deepEqual(hooks, [['connected', accountId, 'private@example.com']])
  assert.equal((await f.runtime.disconnect(accountId)).status, 'disconnected')
  assert.deepEqual(hooks[1], ['disconnected', accountId])
})

test('OAuth progress diagnostics report safe stages through credential persistence', async () => {
  const progress = []
  const f = fixture({
    reportProgress: (account, stage, outcome, code) =>
      progress.push({ account, stage, outcome, code })
  })
  assert.equal((await f.runtime.connect(accountId)).status, 'connected')
  assert.deepEqual(
    progress.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['config', 'started'],
      ['config', 'success'],
      ['connection', 'started'],
      ['authorization', 'started'],
      ['authorization', 'success'],
      ['token_exchange', 'started'],
      ['token_exchange', 'success'],
      ['profile_fetch', 'started'],
      ['profile_fetch', 'success'],
      ['identity_match', 'started'],
      ['identity_match', 'success'],
      ['connection', 'success'],
      ['persistence', 'started'],
      ['persistence', 'success']
    ]
  )
  assert.ok(progress.every((event) => event.account === accountId))
})

test('OAuth progress callback failures do not change connection results', async () => {
  const f = fixture({
    reportProgress: () => {
      throw new Error('private diagnostic writer failure')
    }
  })
  assert.equal((await f.runtime.connect(accountId)).status, 'connected')
})

test('failed identity checks and cancellation skip relay hooks while cancelAll preserves accepted relay state', async () => {
  const hooks = []
  const mismatch = fixture({
    onConnected: (id) => hooks.push(['connected', id]),
    onDisconnected: (id) => hooks.push(['disconnected', id]),
    fetchProfile: async () => 'different@example.com'
  })
  assert.equal((await mismatch.runtime.connect(accountId)).status, 'error')
  assert.deepEqual(hooks, [])

  const deferredAuthorization = fixture({
    onConnected: (id) => hooks.push(['connected', id]),
    onDisconnected: (id) => hooks.push(['disconnected', id]),
    startAuthorization: () => ({ result: new Promise(() => {}), cancel: () => undefined })
  })
  const pending = deferredAuthorization.runtime.connect(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(deferredAuthorization.runtime.hasPendingConnections(), true)
  await deferredAuthorization.runtime.cancel(accountId)
  assert.equal(deferredAuthorization.runtime.hasPendingConnections(), false)
  await pending
  assert.deepEqual(hooks, [])

  const connected = fixture({
    onConnected: (id) => hooks.push(['connected', id]),
    onDisconnected: (id) => hooks.push(['disconnected', id])
  })
  await connected.runtime.connect(accountId)
  await connected.runtime.cancelAll()
  assert.deepEqual(hooks, [['connected', accountId]])
})

test('missing OAuth config fails safely without starting browser authorization', async () => {
  const diagnostics = []
  const f = fixture({
    reportFailure: (stage, code) => diagnostics.push([stage, code]),
    loadConfig: () => {
      throw new Error('private config failure')
    }
  })
  const result = await f.runtime.connect(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'error' })
  assert.equal(f.calls.authorization, 0)
  assert.deepEqual(diagnostics, [['config', 'config_unavailable']])
})

test('connection diagnostics report only allowlisted failure codes and cannot break the result', async () => {
  const diagnostics = []
  const f = fixture({
    reportFailure: (stage, code) => {
      diagnostics.push([stage, code])
      throw new Error('observer failure')
    },
    readWebIdentity: async () => {
      throw new Error('private identity data')
    }
  })
  const result = await f.runtime.connect(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'error' })
  assert.deepEqual(diagnostics, [['connection', 'identity_unavailable']])
  assert.equal(JSON.stringify(diagnostics).includes('private'), false)
})

test('an unavailable web identity still opens authorization but stores no grant', async () => {
  const diagnostics = []
  const f = fixture({
    reportFailure: (stage, code) => diagnostics.push([stage, code]),
    readWebIdentity: async () => ({ accountExists: true, emailAddress: null })
  })
  const result = await f.runtime.connect(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'error' })
  assert.equal(f.calls.authorization, 1)
  assert.deepEqual(diagnostics, [['connection', 'identity_unavailable']])
})

test('identity mismatch progress records only its allowlisted failure code', async () => {
  const progress = []
  const f = fixture({
    reportProgress: (account, stage, outcome, code) =>
      progress.push({ account, stage, outcome, code }),
    fetchProfile: async () => 'different@example.com'
  })
  assert.equal((await f.runtime.connect(accountId)).status, 'error')
  assert.deepEqual(progress.at(-2), {
    account: accountId,
    stage: 'identity_match',
    outcome: 'failure',
    code: 'identity_mismatch'
  })
})

test('persistence diagnostics identify acceptance failure without exposing its error', async () => {
  const diagnostics = []
  const f = fixture({
    reportFailure: (stage, code) => diagnostics.push([stage, code]),
    manager: {
      acceptConnection: async () => {
        throw new Error('private storage detail')
      }
    }
  })
  const result = await f.runtime.connect(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'error' })
  assert.deepEqual(diagnostics, [['persistence', 'accept_failed']])
})

test('same-turn cancel prevents a queued connect from opening the browser', async () => {
  const f = fixture()
  const connecting = f.runtime.connect(accountId)
  const canceled = f.runtime.cancel(accountId)
  assert.equal((await connecting).status, 'disconnected')
  assert.equal((await canceled).status, 'connected')
  assert.equal(f.calls.authorization, 0)
})

test('same-turn disconnect fences a queued connect before it starts authorization', async () => {
  const f = fixture()
  const connecting = f.runtime.connect(accountId)
  const disconnecting = f.runtime.disconnect(accountId)
  assert.equal((await connecting).status, 'disconnected')
  assert.equal((await disconnecting).status, 'disconnected')
  assert.equal(f.calls.authorization, 0)
  assert.equal(f.calls.disconnect, 1)
})

test('same-turn shutdown fences a queued connect before it starts authorization', async () => {
  const f = fixture()
  const connecting = f.runtime.connect(accountId)
  await f.runtime.cancelAll()
  assert.equal((await connecting).status, 'disconnected')
  assert.equal(f.calls.authorization, 0)
  assert.equal(f.calls.disconnect, 0)
})

test('same-turn connects leave only the newest operation active', async () => {
  const f = fixture()
  const first = f.runtime.connect(accountId)
  const second = f.runtime.connect(accountId)
  assert.equal((await first).status, 'disconnected')
  assert.equal((await second).status, 'connected')
  assert.equal(f.calls.authorization, 1)
})

test('cancel before persistence preserves the existing grant and reports its current status', async () => {
  const auth = deferred()
  const f = fixture({
    startAuthorization: () => ({
      result: auth.promise,
      cancel: () => auth.reject({ code: 'cancelled' })
    })
  })
  const pending = f.runtime.connect(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  const result = await f.runtime.cancel(accountId)
  assert.deepEqual({ ...result }, { accountId, status: 'connected' })
  assert.equal(f.calls.disconnect, 0)
  assert.equal((await pending).status, 'disconnected')
})

test('cancelling while persistence is pending fences it and returns an error if cleanup fails', async () => {
  const acceptance = deferred()
  const started = deferred()
  const f = fixture({
    manager: {
      acceptConnection: () => {
        started.resolve()
        return acceptance.promise
      },
      disconnect: async () => {
        throw new Error('private storage failure')
      }
    }
  })
  const pending = f.runtime.connect(accountId)
  await started.promise
  const canceled = await f.runtime.cancel(accountId)
  assert.deepEqual({ ...canceled }, { accountId, status: 'error' })
  acceptance.resolve({ status: 'connected' })
  assert.equal((await pending).status, 'disconnected')
})

test('late acceptance completion cannot disconnect a newer successful connection', async () => {
  const oldAcceptance = deferred()
  const oldStarted = deferred()
  const f = fixture({
    manager: {
      acceptConnection: async () => {
        f.calls.accept += 1
        if (f.calls.accept === 1) {
          oldStarted.resolve()
          return oldAcceptance.promise
        }
        f.state.status = 'connected'
        return { status: 'connected' }
      }
    }
  })
  const oldConnect = f.runtime.connect(accountId)
  await oldStarted.promise
  const newer = await f.runtime.connect(accountId)
  assert.deepEqual({ ...newer }, { accountId, status: 'connected' })
  const disconnectsAfterNewerSuccess = f.calls.disconnect
  oldAcceptance.resolve({ status: 'connected' })
  assert.equal((await oldConnect).status, 'disconnected')
  assert.equal(f.calls.disconnect, disconnectsAfterNewerSuccess)
})
