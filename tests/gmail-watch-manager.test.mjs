/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

class GmailMetadataFailure extends Error {
  constructor(code) {
    super('private provider detail')
    this.code = code
  }
}

const sourceUrl = new URL('../src/main/gmail-watch-manager.ts', import.meta.url)
const { createGmailWatchManager, GmailWatchManagerFailure } = loadTypeScript(sourceUrl, {
  './gmail-metadata': { GmailMetadataFailure }
})
const accountId = '123e4567-e89b-42d3-a456-426614174000'
const otherAccountId = '123e4567-e89b-42d3-a456-426614174001'
const baseNow = 1_800_000_000_000

function fixture(
  registerWatch = async () => ({ expiresAt: baseNow + 604_800_000 }),
  exists = () => true
) {
  const calls = []
  const manager = createGmailWatchManager({
    accountExists: exists,
    registerWatch: (id, signal) => {
      calls.push({ id, signal })
      return registerWatch(id, signal)
    }
  })
  return { manager, calls }
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

function result(id, status, nextAttemptAt) {
  return { accountId: id, status, nextAttemptAt }
}

test('connect renews immediately and schedules a daily attempt at the due boundary', async () => {
  const { manager, calls } = fixture()
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'renewed', baseNow + 86_400_000)
  )
  assert.equal(calls.length, 1)
  assert.equal(manager.getNextDueAt(), baseNow + 86_400_000)
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 86_399_999)), [])
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 86_400_000)), [
    result(accountId, 'renewed', baseNow + 86_400_000 * 2)
  ])
  manager.dispose()
})

test('short lease schedules halfway through its remaining lifetime', async () => {
  const { manager } = fixture(async (_id, signal) => {
    assert.equal(signal instanceof AbortSignal, true)
    return { expiresAt: baseNow + 90_001 }
  })
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'renewed', baseNow + 45_000)
  )
  manager.dispose()
})

test('invalid lease results block automatic renewal', async () => {
  for (const lease of [
    null,
    undefined,
    {},
    { expiresAt: baseNow },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 }
  ]) {
    const { manager, calls } = fixture(async () => lease)
    assert.deepEqual(
      structuredClone(await manager.connect(accountId, baseNow)),
      result(accountId, 'blocked', null)
    )
    assert.equal(manager.getNextDueAt(), null)
    assert.equal(calls.length, 1)
    manager.dispose()
  }
})

test('simultaneous connects coalesce and return the shared outcome', async () => {
  const gate = deferred()
  const { manager, calls } = fixture(() => gate.promise)
  const first = manager.connect(accountId, baseNow)
  const second = manager.connect(accountId, baseNow + 1)
  await Promise.resolve()
  assert.equal(calls.length, 1)
  gate.resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(structuredClone(await Promise.all([first, second])), [
    result(accountId, 'renewed', baseNow + 86_400_000),
    result(accountId, 'renewed', baseNow + 86_400_000)
  ])
  manager.dispose()
})

test('accounts attempt independently when one registration fails', async () => {
  const { manager, calls } = fixture(async (id) => {
    if (id === accountId) throw Error('private secret')
    return { expiresAt: baseNow + 604_800_000 }
  })
  assert.deepEqual(
    structuredClone(
      await Promise.all([
        manager.connect(accountId, baseNow),
        manager.connect(otherAccountId, baseNow)
      ])
    ),
    [
      result(accountId, 'retry', baseNow + 60_000),
      result(otherAccountId, 'renewed', baseNow + 86_400_000)
    ]
  )
  assert.equal(calls.length, 2)
  manager.dispose()
})

test('transient retries use capped backoff and reconnect cannot bypass cooldown', async () => {
  const { manager, calls } = fixture(async () => {
    throw Error('private secret')
  })
  let now = baseNow
  for (const delay of [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]) {
    const attempt = await manager.connect(accountId, now)
    assert.deepEqual(structuredClone(attempt), result(accountId, 'retry', now + delay))
    const callCount = calls.length
    assert.deepEqual(
      structuredClone(await manager.connect(accountId, now + 1)),
      structuredClone(attempt)
    )
    assert.equal(calls.length, callCount)
    now += delay
  }
  manager.dispose()
})

test('successful registration resets retry backoff', async () => {
  let attempts = 0
  const { manager } = fixture(async () => {
    if (attempts === 0 || attempts === 1 || attempts === 3) {
      attempts += 1
      throw Error('offline')
    }
    attempts += 1
    return { expiresAt: baseNow + 604_800_000 }
  })
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'retry', baseNow + 60_000)
  )
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 60_000)), [
    result(accountId, 'retry', baseNow + 180_000)
  ])
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 180_000)), [
    result(accountId, 'renewed', baseNow + 180_000 + 86_400_000)
  ])
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 180_000 + 86_400_000)), [
    result(accountId, 'retry', baseNow + 180_000 + 86_400_000 + 60_000)
  ])
  manager.dispose()
})

test('authorization and invalid response failures block until disconnect and reconnect', async () => {
  let code = 'unauthorized'
  const { manager, calls } = fixture(async () => {
    throw new GmailMetadataFailure(code)
  })
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'blocked', null)
  )
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow + 999_999)),
    result(accountId, 'blocked', null)
  )
  assert.equal(manager.getNextDueAt(), null)
  assert.equal(calls.length, 1)
  manager.disconnect(accountId)
  code = 'invalid_response'
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow + 1)),
    result(accountId, 'blocked', null)
  )
  manager.dispose()
})

test('pause cancels active work and resume renews overdue entries but leaves future entries alone', async () => {
  let mode = 'pending'
  const gate = deferred()
  const { manager, calls } = fixture(async () =>
    mode === 'pending' ? gate.promise : { expiresAt: baseNow + 604_800_000 }
  )
  const pending = manager.connect(accountId, baseNow)
  await Promise.resolve()
  manager.pause()
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(manager.getNextDueAt(), null)
  mode = 'success'
  gate.resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(structuredClone(await pending), result(accountId, 'cancelled', null))
  assert.deepEqual(structuredClone(await manager.resume(baseNow + 10)), [
    result(accountId, 'renewed', baseNow + 10 + 86_400_000)
  ])
  const future = await manager.resume(baseNow + 9 + 86_400_000)
  assert.deepEqual(structuredClone(future), [])
  assert.equal(manager.getNextDueAt(), baseNow + 10 + 86_400_000)
  manager.dispose()
})

test('pause preserves retry cooldown and blocked status through reconnects', async () => {
  const { manager, calls } = fixture(async () => {
    throw new GmailMetadataFailure('unauthorized')
  })
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'blocked', null)
  )
  manager.pause()
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow + 1)),
    result(accountId, 'blocked', null)
  )
  assert.deepEqual(structuredClone(await manager.resume(baseNow + 2)), [])
  assert.equal(calls.length, 1)
  manager.disconnect(accountId)
  manager.dispose()

  const retry = fixture(async () => {
    throw Error('offline')
  })
  assert.deepEqual(
    structuredClone(await retry.manager.connect(accountId, baseNow)),
    result(accountId, 'retry', baseNow + 60_000)
  )
  retry.manager.pause()
  assert.deepEqual(
    structuredClone(await retry.manager.connect(accountId, baseNow + 1)),
    result(accountId, 'retry', baseNow + 60_000)
  )
  assert.deepEqual(structuredClone(await retry.manager.resume(baseNow + 2)), [])
  assert.equal(retry.calls.length, 1)
  retry.manager.dispose()
})

test('late success and failure after pause cannot change state', async () => {
  for (const settle of [
    (gate) => gate.resolve({ expiresAt: baseNow + 604_800_000 }),
    (gate) => gate.reject(Error('private failure'))
  ]) {
    const gate = deferred()
    const { manager } = fixture(() => gate.promise)
    const pending = manager.connect(accountId, baseNow)
    await Promise.resolve()
    manager.pause()
    settle(gate)
    assert.deepEqual(structuredClone(await pending), result(accountId, 'cancelled', null))
    assert.equal(manager.getNextDueAt(), null)
    manager.dispose()
  }
})

test('late completion after pause and resume cannot replace the resumed flight', async () => {
  const gates = [deferred(), deferred()]
  let index = 0
  const { manager, calls } = fixture(() => gates[index++].promise)
  const interrupted = manager.connect(accountId, baseNow)
  await Promise.resolve()
  manager.pause()
  const resumed = manager.resume(baseNow + 1)
  await Promise.resolve()
  assert.equal(calls.length, 2)
  const follower = manager.connect(accountId, baseNow + 2)
  gates[0].resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(structuredClone(await interrupted), result(accountId, 'cancelled', null))
  assert.equal(manager.getNextDueAt(), null)
  gates[1].resolve({ expiresAt: baseNow + 604_800_000 })
  const expected = result(accountId, 'renewed', baseNow + 1 + 86_400_000)
  assert.deepEqual(structuredClone(await resumed), [expected])
  assert.deepEqual(structuredClone(await follower), expected)
  assert.equal(calls.length, 2)
  manager.dispose()
})

test('disconnect removes entry before abort and allows fresh work before old promise settles', async () => {
  const gates = [deferred(), deferred()]
  let index = 0
  const { manager, calls } = fixture(() => gates[index++].promise)
  const stale = manager.connect(accountId, baseNow)
  await Promise.resolve()
  manager.disconnect(accountId)
  assert.equal(calls[0].signal.aborted, true)
  const fresh = manager.connect(accountId, baseNow + 1)
  gates[1].resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(
    structuredClone(await fresh),
    result(accountId, 'renewed', baseNow + 1 + 86_400_000)
  )
  gates[0].resolve({ expiresAt: baseNow + 999_999_999 })
  assert.deepEqual(structuredClone(await stale), result(accountId, 'cancelled', null))
  assert.equal(manager.getNextDueAt(), baseNow + 1 + 86_400_000)
  manager.dispose()
})

test('account removal before or during registration removes the entry without retaining a lease', async () => {
  let active = true
  const gate = deferred()
  const { manager } = fixture(
    () => gate.promise,
    () => active
  )
  const pending = manager.connect(accountId, baseNow)
  await Promise.resolve()
  active = false
  gate.resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(structuredClone(await pending), result(accountId, 'cancelled', null))
  assert.equal(manager.getNextDueAt(), null)
  await assert.rejects(
    manager.connect(accountId, baseNow + 1),
    (error) => error.code === 'invalid_account'
  )
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 100_000_000)), [])
  manager.dispose()
})

test('account removal followed by registration rejection cancels and removes the entry', async () => {
  let active = true
  const gate = deferred()
  const { manager } = fixture(
    () => gate.promise,
    () => active
  )
  const pending = manager.connect(accountId, baseNow)
  await Promise.resolve()
  active = false
  gate.reject(Error('private provider error'))
  assert.deepEqual(structuredClone(await pending), result(accountId, 'cancelled', null))
  assert.equal(manager.getNextDueAt(), null)
  manager.dispose()
})

test('runDue removes inactive accounts even when their lease is not due or is blocked', async () => {
  const inactive = new Set()
  const { manager, calls } = fixture(
    async () => {
      if (calls.length === 2) throw new GmailMetadataFailure('unauthorized')
      return { expiresAt: baseNow + 604_800_000 }
    },
    (id) => !inactive.has(id)
  )
  await manager.connect(accountId, baseNow)
  await manager.connect(otherAccountId, baseNow)
  inactive.add(accountId)
  inactive.add(otherAccountId)
  assert.deepEqual(structuredClone(await manager.runDue(baseNow + 1)), [])
  assert.equal(manager.getNextDueAt(), null)
  assert.equal(calls.length, 2)
  manager.dispose()
})

test('dispose fences pending work and rejects future asynchronous calls', async () => {
  const gate = deferred()
  const { manager, calls } = fixture(() => gate.promise)
  const pending = manager.connect(accountId, baseNow)
  await Promise.resolve()
  manager.dispose()
  assert.equal(calls[0].signal.aborted, true)
  assert.equal(manager.getNextDueAt(), null)
  gate.resolve({ expiresAt: baseNow + 604_800_000 })
  assert.deepEqual(structuredClone(await pending), result(accountId, 'cancelled', null))
  await assert.rejects(manager.connect(accountId, baseNow), (error) => error.code === 'disposed')
  await assert.rejects(manager.runDue(baseNow), (error) => error.code === 'disposed')
  await assert.rejects(manager.resume(baseNow), (error) => error.code === 'disposed')
  manager.pause()
  manager.disconnect(accountId)
  manager.dispose()
})

test('invalid UUIDs and times reject before account lookup or registration', async () => {
  let lookups = 0
  const { manager, calls } = fixture(
    async () => ({ expiresAt: baseNow + 100_000 }),
    () => {
      lookups += 1
      return true
    }
  )
  await assert.rejects(
    manager.connect('invalid', baseNow),
    (error) => error.code === 'invalid_account'
  )
  for (const now of [
    -1,
    1.5,
    Infinity,
    Number.MAX_SAFE_INTEGER - 86_399_999,
    Number.MAX_SAFE_INTEGER + 1
  ]) {
    await assert.rejects(manager.connect(accountId, now), (error) => error.code === 'invalid_time')
  }
  assert.equal(lookups, 0)
  assert.equal(calls.length, 0)
  assert.throws(
    () => manager.disconnect('invalid'),
    (error) => error.code === 'invalid_account'
  )
  manager.dispose()
})

test('dependency errors reject sanitized failures before selection and become retries during attempts', async () => {
  const { manager } = fixture(
    async () => ({ expiresAt: baseNow + 604_800_000 }),
    () => {
      throw Error('private account data')
    }
  )
  await assert.rejects(manager.connect(accountId, baseNow), (error) => {
    assert.equal(error instanceof GmailWatchManagerFailure, true)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.message.includes('private'), false)
    assert.equal(error.cause, undefined)
    return true
  })
  manager.dispose()
})

test('account lookup exceptions during attempts retry and selection errors reject sanitized', async () => {
  let lookups = 0
  const { manager } = fixture(
    async () => ({ expiresAt: baseNow + 604_800_000 }),
    () => {
      lookups += 1
      if (lookups === 2 || lookups === 3) throw Error('private account record')
      return true
    }
  )
  assert.deepEqual(
    structuredClone(await manager.connect(accountId, baseNow)),
    result(accountId, 'retry', baseNow + 60_000)
  )
  await assert.rejects(manager.runDue(baseNow + 60_000), (error) => {
    assert.equal(error instanceof GmailWatchManagerFailure, true)
    assert.equal(error.code, 'unavailable')
    assert.equal(error.message.includes('private'), false)
    assert.equal(error.cause, undefined)
    return true
  })
  manager.dispose()
})
