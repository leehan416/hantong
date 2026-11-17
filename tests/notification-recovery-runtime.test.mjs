/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createNotificationRecoveryRuntime } = loadTypeScript(
  new URL('../src/main/notification-recovery-runtime.ts', import.meta.url),
  { electron: { dialog: {} } }
)
const { createAccountAccessController } = loadTypeScript(
  new URL('../src/main/account-access-controller.ts', import.meta.url),
  {}
)

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function createRuntime(recover) {
  let flushes = 0
  const runtime = createNotificationRecoveryRuntime({
    window: () => null,
    views: () => ({
      getActiveAccountId: () => 'account',
      getDocumentState: () => ({ ready: true })
    }),
    accessController: () => ({ recover, cancelRecovery: async () => {} }),
    notificationController: () => ({ flushAlerts: () => (flushes += 1) }),
    accountRemoval: () => null,
    accountStore: () => ({ getState: () => ({ accounts: [{ id: 'account' }] }) }),
    isQuitting: () => false,
    locale: () => 'en',
    showAccount: () => {}
  })
  return { runtime, flushes: () => flushes }
}

function integratedRecovery() {
  const accountId = '11111111-1111-4111-8111-111111111111'
  let allowed = false
  let email = 'user@example.com'
  let generation = 1
  let active = true
  let finishAuthorization
  let authorizationCalls = 0
  let cancellationCalls = 0
  let profileRead = async () => email
  let identityRead = async () => ({ accountExists: true, emailAddress: 'user@example.com' })
  let cancellationGate = Promise.resolve()
  const access = createAccountAccessController({
    views: {
      getActiveAccountId: () => (active ? accountId : null),
      getDocumentState: () => ({ revision: 1, kind: 'mail', ready: true }),
      readWebIdentity: async (...args) => identityRead(...args),
      setMailAccess: (_id, value) => {
        allowed = value
        return true
      }
    },
    runtime: {
      getStatus: async () => ({ status: 'connected' }),
      connect: async () => {
        authorizationCalls += 1
        return new Promise((resolve) => {
          finishAuthorization = (status) => resolve({ status })
        })
      },
      cancel: async () => {
        cancellationCalls += 1
        finishAuthorization?.('disconnected')
        await cancellationGate
        return { status: 'connected' }
      },
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({ status: 'connected', emailAddress: email }),
      getAccessToken: async () => 'token',
      getGeneration: () => generation
    },
    loadConfig: () => ({}),
    fetchProfile: async (...args) => profileRead(...args),
    accountExists: () => true,
    onWebIdentity: () => {},
    publish: () => {},
    now: () => 100
  })
  const runtime = createNotificationRecoveryRuntime({
    window: () => null,
    views: () => ({
      getActiveAccountId: () => (active ? accountId : null),
      getDocumentState: () => ({ ready: true })
    }),
    accessController: () => access,
    notificationController: () => null,
    accountRemoval: () => null,
    accountStore: () => ({ getState: () => ({ accounts: [{ id: accountId }] }) }),
    isQuitting: () => false,
    locale: () => 'en',
    showAccount: () => {}
  })
  return {
    accountId,
    access,
    runtime,
    allowed: () => allowed,
    authorizationCalls: () => authorizationCalls,
    cancellationCalls: () => cancellationCalls,
    finish: (status, acceptedEmail = 'user@example.com') => {
      if (status === 'connected') {
        email = acceptedEmail
        generation += 1
      }
      finishAuthorization?.(status)
    },
    setProfileRead: (read) => {
      profileRead = read
    },
    setIdentityRead: (read) => {
      identityRead = read
    },
    setCancellationGate: (gate) => {
      cancellationGate = gate
    },
    switchAccount: () => {
      active = false
    }
  }
}

test('cleared recovery completion cannot remove a newer pending request', async () => {
  const firstConnection = deferred()
  const secondConnection = deferred()
  const connections = [firstConnection, secondConnection]
  let calls = 0
  const { runtime } = createRuntime(() => {
    const connection = connections[calls++]
    return connection.promise
  })

  const oldPromise = runtime.request('account')
  assert.equal(runtime.request('account'), oldPromise)
  assert.equal(calls, 1)
  runtime.clearPending('account')
  await assert.rejects(oldPromise, /cancelled/)

  const currentPromise = runtime.request('account')
  assert.equal(calls, 2)
  firstConnection.resolve({ connectionStatus: 'connected' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.hasPending('account'), true)

  secondConnection.resolve({ connectionStatus: 'connected' })
  await currentPromise
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.hasPending('account'), false)
})

test('explicit notification recovery obtains fresh authorization while retaining validated mail access', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  assert.equal(f.allowed(), true)
  const recovery = f.runtime.request(f.accountId)
  assert.equal(f.authorizationCalls(), 1)
  assert.equal(f.allowed(), true)
  f.finish('connected')
  await recovery
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('accepted fresh grant locks old mail until profile and web identity checks finish', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const profile = deferred()
  const webIdentity = deferred()
  f.setProfileRead(() => profile.promise)
  f.setIdentityRead(() => webIdentity.promise)
  const recovery = f.runtime.request(f.accountId)
  f.finish('connected')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.allowed(), false)
  assert.equal(f.access.getState(f.accountId).status, 'checking')
  profile.resolve('user@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.allowed(), false)
  webIdentity.resolve({ accountExists: true, emailAddress: 'user@example.com' })
  await recovery
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('accepted grant with a different Gmail identity stays locked during and after validation', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const profile = deferred()
  const webIdentity = deferred()
  f.setProfileRead(() => profile.promise)
  f.setIdentityRead(() => webIdentity.promise)
  const recovery = f.runtime.request(f.accountId)
  f.finish('connected', 'other@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.allowed(), false)
  profile.resolve('other@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.allowed(), false)
  webIdentity.resolve({ accountExists: true, emailAddress: 'user@example.com' })
  await assert.rejects(recovery)
  assert.equal(f.allowed(), false)
})

test('cancelled notification recovery preserves the same validated grant and rejects recovery', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const recovery = f.runtime.request(f.accountId)
  const cancellation = f.runtime.clearPending(f.accountId)
  await assert.rejects(recovery, /cancelled/)
  await cancellation
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('a real recovery can restart after cancellation without the old result changing access', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const oldRecovery = f.runtime.request(f.accountId)
  const cancellation = f.runtime.clearPending(f.accountId)
  await assert.rejects(oldRecovery, /cancelled/)
  await cancellation
  const newRecovery = f.runtime.request(f.accountId)
  assert.equal(f.authorizationCalls(), 2)
  f.finish('connected')
  await newRecovery
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('immediate retry waits for in-flight cancellation and starts its own authorization', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const cancellationGate = deferred()
  f.setCancellationGate(cancellationGate.promise)
  const oldRecovery = f.runtime.request(f.accountId)
  const cancellation = f.runtime.clearPending(f.accountId)
  await assert.rejects(oldRecovery, /cancelled/)
  const newRecovery = f.runtime.request(f.accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.authorizationCalls(), 1)
  assert.equal(f.allowed(), true)
  cancellationGate.resolve()
  await cancellation
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.authorizationCalls(), 2)
  assert.equal(f.allowed(), true)
  f.finish('connected')
  await newRecovery
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('late cancelled validation cannot make a newer recovery uncancellable', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const oldProfile = deferred()
  const oldIdentity = deferred()
  f.setProfileRead(() => oldProfile.promise)
  f.setIdentityRead(() => oldIdentity.promise)
  const oldRecovery = f.runtime.request(f.accountId)
  f.finish('connected')
  await new Promise((resolve) => setImmediate(resolve))
  const cancellation = f.runtime.clearPending(f.accountId)
  await assert.rejects(oldRecovery, /cancelled/)
  await cancellation
  assert.equal(f.allowed(), false)
  const newRecovery = f.runtime.request(f.accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.authorizationCalls(), 2)
  oldProfile.resolve('user@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  oldIdentity.resolve({ accountExists: true, emailAddress: 'user@example.com' })
  await new Promise((resolve) => setImmediate(resolve))
  const newCancellation = f.runtime.clearPending(f.accountId)
  await assert.rejects(newRecovery, /cancelled/)
  await newCancellation
  assert.equal(f.allowed(), false)
  assert.equal(f.access.getState(f.accountId).status, 'required')
  assert.equal(f.cancellationCalls(), 2)
  assert.equal(f.authorizationCalls(), 2)
})
test('failed notification recovery preserves validated access but remains a failed recovery', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const recovery = f.runtime.request(f.accountId)
  f.finish('error')
  await assert.rejects(recovery)
  assert.equal(f.allowed(), true)
  assert.equal(f.access.getState(f.accountId).status, 'ready')
})

test('fresh authorization for a different Gmail identity locks native mail access', async () => {
  const f = integratedRecovery()
  await f.access.connect(f.accountId)
  const recovery = f.runtime.request(f.accountId)
  f.finish('connected', 'other@example.com')
  await assert.rejects(recovery, /did not complete/)
  assert.equal(f.allowed(), false)
  assert.equal(f.access.getState(f.accountId).connectionStatus, 'reconnect_required')
})
