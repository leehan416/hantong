/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const accountId = '11111111-1111-4111-8111-111111111111'
const { createAccountAccessController } = loadTypeScript(
  new URL('../src/main/account-access-controller.ts', import.meta.url),
  {}
)

function fixture(overrides = {}) {
  let document = { revision: 4, kind: 'mail', ready: true }
  let activeAccountId = accountId
  let readIdentity = async () => ({ accountExists: true, emailAddress: 'user@example.com' })
  let connection = { status: 'disconnected' }
  let profileEmail = 'user@example.com'
  let connect = async () => {
    connection = { status: 'connected', emailAddress: 'user@example.com' }
    return { status: 'connected' }
  }
  const grants = []
  const published = []
  const webIdentityEmails = []
  let accessTokenReads = 0
  let profileReads = 0
  const controller = createAccountAccessController({
    views: {
      getActiveAccountId: () => activeAccountId,
      getDocumentState: () => document,
      readWebIdentity: (...args) => readIdentity(...args),
      setMailAccess: (...args) => {
        grants.push(args)
        return args[1] ? args[2] === document.revision : true
      }
    },
    runtime: {
      getStatus: async () => connection,
      connect: async (...args) => {
        const result = await connect(...args)
        if (result.status === 'connected')
          connection = { status: 'connected', emailAddress: 'user@example.com' }
        return result
      },
      cancel: async () => connection,
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => connection,
      getAccessToken: async () => {
        accessTokenReads += 1
        return 'opaque-test-token'
      }
    },
    loadConfig: () => ({}),
    fetchProfile: async () => {
      profileReads += 1
      return profileEmail
    },
    accountExists: (id) => id === accountId,
    onWebIdentity: (id, email) => webIdentityEmails.push([id, email]),
    publish: (state) => published.push(structuredClone(state)),
    ...overrides
  })
  return {
    controller,
    grants,
    published,
    webIdentityEmails,
    get accessTokenReads() {
      return accessTokenReads
    },
    get profileReads() {
      return profileReads
    },
    setDocument(value) {
      document = value
    },
    setActiveAccount(value) {
      activeAccountId = value
    },
    setIdentity(value) {
      readIdentity = typeof value === 'function' ? value : async () => value
    },
    setConnection(value) {
      connection = value
    },
    setProfileEmail(value) {
      profileEmail = value
    },
    setConnect(value) {
      connect = value
    }
  }
}

test('automatic OAuth grants mail only after live token profile and web identity match', async () => {
  const f = fixture()
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(f.grants.at(-1), [accountId, true, 4])
  assert.equal(f.controller.getState(accountId).status, 'ready')
  assert.equal(f.controller.getState(accountId).connectionStatus, 'connected')
  assert.deepEqual(f.webIdentityEmails, [[accountId, 'user@example.com']])
  f.controller.dispose()
})

test('missing or untrusted Gmail web identity is never recorded as a verified email', async () => {
  const f = fixture()
  f.setIdentity({ accountExists: false, emailAddress: 'spoof@example.com' })
  await f.controller.connect(accountId)
  assert.deepEqual(f.webIdentityEmails, [])
  f.controller.dispose()
})

test('saved connection metadata alone never opens the Gmail view', async () => {
  const f = fixture()
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  f.setProfileEmail('other@example.com')
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  assert.equal(f.controller.getState(accountId).status, 'error')
  f.controller.dispose()
})

test('explicit reconnect can replace a cached grant that failed live profile validation', async () => {
  let oauthLaunches = 0
  const f = fixture()
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  f.setProfileEmail('other@example.com')
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.getState(accountId).status, 'error')
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  f.setConnect(async () => {
    oauthLaunches += 1
    f.setProfileEmail('user@example.com')
    return { status: 'connected' }
  })
  await f.controller.connect(accountId)
  assert.equal(oauthLaunches, 1)
  assert.equal(f.controller.getState(accountId).status, 'ready')
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    true
  )
  f.controller.dispose()
})

test('intentional disconnect keeps an otherwise valid stored grant locked', async () => {
  const f = fixture()
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  await f.controller.disconnect(accountId)
  f.setDocument({ revision: 5, kind: 'mail', ready: true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  assert.equal(f.controller.getState(accountId).status, 'required')
  f.controller.dispose()
})

test('late OAuth completion after cancellation cannot restore mail access', async () => {
  let finishConnect
  const f = fixture()
  f.setConnect(
    () =>
      new Promise((resolve) => {
        finishConnect = resolve
      })
  )
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  await f.controller.cancel(accountId)
  finishConnect({ status: 'connected' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  assert.equal(f.controller.getState(accountId).status, 'required')
  f.controller.dispose()
})

test('cancellation before identity readiness prevents the queued automatic launch', async () => {
  let releaseIdentity
  let launches = 0
  const f = fixture()
  f.setIdentity(
    () =>
      new Promise((resolve) => {
        releaseIdentity = resolve
      })
  )
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.controller.onViewReady(accountId)
  await f.controller.cancel(accountId)
  releaseIdentity({ accountExists: true, emailAddress: 'user@example.com' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches, 0)
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  f.controller.dispose()
})

test('cancellation during cached-grant validation cannot fall through to OAuth', async () => {
  let releaseProfile
  let launches = 0
  const f = fixture({
    fetchProfile: () =>
      new Promise((resolve) => {
        releaseProfile = resolve
      })
  })
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  await f.controller.cancel(accountId)
  releaseProfile('user@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches, 0)
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  f.controller.dispose()
})

test('same document ready notification does not relaunch OAuth', async () => {
  const f = fixture()
  f.controller.onViewReady(accountId)
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.accessTokenReads, 1)
  assert.equal(f.profileReads, 1)
  f.controller.dispose()
})

test('account switch during validation cannot grant the inactive view', async () => {
  const f = fixture()
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  let releaseProfile
  const original = f.controller
  // A deferred profile boundary lets the active account change while Main validates.
  const switched = fixture({
    fetchProfile: () =>
      new Promise((resolve) => {
        releaseProfile = resolve
      })
  })
  switched.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  switched.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  switched.setActiveAccount('22222222-2222-4222-8222-222222222222')
  releaseProfile('user@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    switched.grants.some((grant) => grant[1] === true),
    false
  )
  original.dispose()
  switched.controller.dispose()
})

test('switching away cancels pending validation and switching back revalidates the document', async () => {
  let releaseFirstProfile
  let profileCalls = 0
  const secondId = '22222222-2222-4222-8222-222222222222'
  const f = fixture({
    accountExists: () => true,
    fetchProfile: async () => {
      profileCalls += 1
      if (profileCalls === 1)
        return new Promise((resolve) => {
          releaseFirstProfile = resolve
        })
      return 'user@example.com'
    }
  })
  f.setConnection({ status: 'connected', emailAddress: 'user@example.com' })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setActiveAccount(secondId)
  f.controller.onViewReady(secondId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.getState(accountId).status, 'required')
  f.setActiveAccount(accountId)
  f.controller.onViewReady(accountId)
  releaseFirstProfile('user@example.com')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(profileCalls, 3)
  assert.equal(f.controller.getState(accountId).status, 'ready')
  assert.equal(
    f.grants.some((grant) => grant[0] === accountId && grant[1] === true),
    true
  )
  f.controller.dispose()
})
