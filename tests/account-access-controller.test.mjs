/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const accountId = '11111111-1111-4111-8111-111111111111'
const otherAccountId = '22222222-2222-4222-8222-222222222222'
const { createAccountAccessController } = loadTypeScript(
  new URL('../src/main/account-access-controller.ts', import.meta.url),
  {}
)

function fixture(overrides = {}) {
  let document = { revision: 4, kind: 'mail', ready: true }
  const documents = new Map([[accountId, document]])
  let activeAccountId = accountId
  let readIdentity = async () => ({ accountExists: true, emailAddress: 'user@example.com' })
  let connection = { status: 'disconnected' }
  let generation = 0
  let clock = 1_000
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
      getDocumentState: (id) => documents.get(id) ?? document,
      readWebIdentity: (...args) => readIdentity(...args),
      setMailAccess: (...args) => {
        grants.push(args)
        return args[1] ? args[2] === (documents.get(args[0]) ?? document).revision : true
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
      getGeneration: () => generation,
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
    now: () => clock,
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
    setDocument(value, id = accountId) {
      if (id === accountId) document = value
      documents.set(id, value)
    },
    setActiveAccount(value) {
      activeAccountId = value
    },
    setIdentity(value) {
      readIdentity = typeof value === 'function' ? value : async () => value
    },
    setConnection(value) {
      connection = value
      generation += 1
    },
    setProfileEmail(value) {
      profileEmail = value
    },
    setConnect(value) {
      connect = value
    },
    bumpGeneration() {
      generation += 1
    },
    setNow(value) {
      clock = value
    }
  }
}

async function switchAwayAndBack(f) {
  f.setDocument({ revision: 1, kind: 'sign_in', ready: true }, otherAccountId)
  f.setActiveAccount(otherAccountId)
  f.controller.onViewReady(otherAccountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setActiveAccount(accountId)
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
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

test('cancellation before the stored grant check prevents the queued automatic launch', async () => {
  let releaseStatus
  let launches = 0
  const f = fixture({
    connections: {
      getStatus: () =>
        new Promise((resolve) => {
          releaseStatus = resolve
        }),
      getAccessToken: async () => 'opaque-test-token'
    }
  })
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.controller.onViewReady(accountId)
  await f.controller.cancel(accountId)
  releaseStatus({ status: 'disconnected' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches, 0)
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  f.controller.dispose()
})

test('unreadable Gmail web identity still launches OAuth but keeps mail locked', async () => {
  let launches = 0
  const timers = []
  const f = fixture({
    setTimeout: (callback) => {
      timers.push(callback)
      return timers.length
    },
    clearTimeout: () => undefined
  })
  f.setIdentity({ accountExists: true, emailAddress: null })
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.controller.onViewReady(accountId)
  for (let tick = 0; tick < 20; tick += 1) {
    await new Promise((resolve) => setImmediate(resolve))
    timers.shift()?.()
  }
  assert.equal(launches, 1)
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  assert.equal(f.controller.getState(accountId).status, 'error')
  f.controller.dispose()
})

test('OAuth email that differs from the Gmail web account keeps mail locked', async () => {
  const f = fixture()
  f.setIdentity({ accountExists: true, emailAddress: 'other@school.ac.kr' })
  await f.controller.connect(accountId)
  assert.equal(
    f.grants.some((grant) => grant[1] === true),
    false
  )
  assert.equal(f.controller.getState(accountId).status, 'error')
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
  const grantCount = f.grants.length
  f.controller.onViewReady(accountId)
  assert.equal(f.accessTokenReads, 1)
  assert.equal(f.profileReads, 1)
  assert.equal(f.grants.length, grantCount)
  f.controller.dispose()
})

test('returning to a verified account rereads Gmail identity without repeating API validation', async () => {
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.accessTokenReads, 1)
  assert.equal(f.profileReads, 1)
  f.setDocument({ revision: 7, kind: 'mail', ready: true }, otherAccountId)
  f.setActiveAccount(otherAccountId)
  f.controller.onViewReady(otherAccountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.getState(otherAccountId).status, 'ready')
  assert.equal(
    f.grants.some(([id, allowed]) => id === otherAccountId && allowed),
    true
  )
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  f.setActiveAccount(accountId)
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.getState(accountId).status, 'ready')
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  assert.equal(
    f.grants.some(([id, allowed]) => id === otherAccountId && !allowed),
    true
  )
  assert.equal(f.webIdentityEmails.filter(([id]) => id === accountId).length, 2)
  assert.deepEqual(f.grants.at(-1), [accountId, true, 4])
  f.controller.dispose()
})

test('a cached Gmail identity mismatch invalidates verification without starting OAuth', async () => {
  let launches = 0
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setIdentity({ accountExists: true, emailAddress: 'other@example.com' })
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  await switchAwayAndBack(f)
  assert.equal(launches, 0)
  assert.equal(f.accessTokenReads, 1)
  assert.equal(f.grants.at(-1)[1], false)
  assert.equal(f.controller.getState(accountId).status, 'error')
  f.controller.dispose()
})

test('expired and changed-generation verification entries perform full API validation', async () => {
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setNow(301_000)
  await switchAwayAndBack(f)
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  f.bumpGeneration()
  await switchAwayAndBack(f)
  assert.equal(f.accessTokenReads, 3)
  assert.equal(f.profileReads, 3)
  f.controller.dispose()
})

test('a document revision change requires a new API verification', async () => {
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setDocument({ revision: 5, kind: 'mail', ready: true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  f.controller.dispose()
})

test('expiry reached during the fresh identity read forces full API validation', async () => {
  const f = fixture({ accountExists: () => true })
  let identityReads = 0
  f.setIdentity(async () => {
    identityReads += 1
    if (identityReads === 2) f.setNow(301_000)
    return { accountExists: true, emailAddress: 'user@example.com' }
  })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  await switchAwayAndBack(f)
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  f.controller.dispose()
})

test('generation change during a cache hit becomes a fresh API validation', async () => {
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  let changed = false
  f.setIdentity(async () => {
    if (!changed) {
      changed = true
      f.bumpGeneration()
    }
    return { accountExists: true, emailAddress: 'user@example.com' }
  })
  await switchAwayAndBack(f)
  assert.equal(f.accessTokenReads, 2)
  assert.equal(f.profileReads, 2)
  assert.equal(f.controller.getState(accountId).status, 'ready', JSON.stringify(f.published))
  f.controller.dispose()
})

test('a cached grant that now needs reconnect does not start OAuth', async () => {
  let launches = 0
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.setConnection({ status: 'reconnect_required', emailAddress: 'user@example.com' })
  await switchAwayAndBack(f)
  assert.equal(launches, 0)
  assert.equal(f.accessTokenReads, 1)
  assert.equal(f.profileReads, 1)
  assert.equal(f.controller.getState(accountId).status, 'error')
  assert.equal(f.controller.getState(accountId).connectionStatus, 'reconnect_required')
  f.controller.dispose()
})

test('invalid_grant during a pending cache identity read cannot restore access or launch OAuth', async () => {
  let releaseIdentity
  let launches = 0
  const f = fixture({ accountExists: () => true })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setConnect(async () => {
    launches += 1
    return { status: 'connected' }
  })
  f.setIdentity(
    () =>
      new Promise((resolve) => {
        releaseIdentity = resolve
      })
  )
  f.setDocument({ revision: 1, kind: 'sign_in', ready: true }, otherAccountId)
  f.setActiveAccount(otherAccountId)
  f.controller.onViewReady(otherAccountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setActiveAccount(accountId)
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setConnection({ status: 'reconnect_required', emailAddress: 'user@example.com' })
  releaseIdentity({ accountExists: true, emailAddress: 'user@example.com' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(launches, 0)
  assert.equal(f.grants.filter((grant) => grant[1]).length, 1)
  assert.equal(f.controller.getState(accountId).status, 'error')
  f.controller.dispose()
})

test('invalidating a pending cached identity read aborts its retry and prevents a grant', async () => {
  const timers = []
  const f = fixture({
    accountExists: () => true,
    setTimeout: (callback) => {
      const handle = { callback }
      timers.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle)
      if (index >= 0) timers.splice(index, 1)
    }
  })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  f.setIdentity({ accountExists: true, emailAddress: null })
  await switchAwayAndBack(f)
  const pendingGrants = f.grants.length
  assert.equal(timers.length, 1)
  f.controller.invalidate(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.length, 0)
  assert.equal(f.grants.length, pendingGrants + 1)
  assert.equal(f.grants.at(-1)[1], false)
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

test('explicit connect on another account cancels the previous pending OAuth', async () => {
  const otherId = '22222222-2222-4222-8222-222222222222'
  const cancelled = []
  const f = fixture({
    accountExists: () => true,
    runtime: {
      connect: async (id) =>
        id === accountId ? new Promise(() => undefined) : { status: 'disconnected' },
      cancel: async (id) => {
        cancelled.push(id)
        return { status: 'disconnected' }
      },
      disconnect: async () => ({ status: 'disconnected' })
    }
  })
  f.controller.onViewReady(accountId)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.getState(accountId).connectionStatus, 'connecting')
  f.setActiveAccount(otherId)
  await f.controller.connect(otherId)
  assert.deepEqual(cancelled, [accountId])
  assert.deepEqual(
    { ...f.controller.getState(accountId) },
    { accountId, status: 'required', connectionStatus: 'disconnected' }
  )
  f.controller.dispose()
})
