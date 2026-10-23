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
const { createGmailWatchManager } = loadTypeScript(sourceUrl, {
  './gmail-metadata': { GmailMetadataFailure }
})
const accountId = '123e4567-e89b-42d3-a456-426614174000'
const baseNow = 1_800_000_000_000

function fixture(
  registerWatch = async () => ({ expiresAt: baseNow + 604_800_000 }),
  exists = () => true
) {
  const calls = []
  const diagnostics = []
  const manager = createGmailWatchManager({
    accountExists: exists,
    onDiagnostic: (event) => diagnostics.push(event),
    registerWatch: (id, signal) => {
      calls.push({ id, signal })
      return registerWatch(id, signal)
    }
  })
  return { manager, calls, diagnostics }
}

function result(id, status, nextAttemptAt) {
  return { accountId: id, status, nextAttemptAt }
}

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
  const { manager, calls, diagnostics } = fixture(async () => {
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
  assert.equal(diagnostics.at(-1).code, 'invalid_response')
  manager.dispose()
})

test('explicit retry clears a blocked watch lease and reports its actual authorization code', async () => {
  let shouldBlock = true
  const { manager, diagnostics } = fixture(async () => {
    if (shouldBlock) throw new GmailMetadataFailure('forbidden')
    return { expiresAt: baseNow + 604_800_000 }
  })
  await manager.connect(accountId, baseNow)
  assert.equal(diagnostics.at(-1).code, 'forbidden')
  shouldBlock = false
  assert.deepEqual(
    structuredClone(await manager.retry(accountId, baseNow + 1000)),
    result(accountId, 'renewed', baseNow + 1000 + 86_400_000)
  )
  manager.dispose()
})

test('watch diagnostic reports retry and blocked outcomes without provider error text', async () => {
  const retry = fixture(async () => {
    throw Error('SECRET provider body')
  })
  await retry.manager.connect(accountId, baseNow)
  assert.equal(retry.diagnostics[0].status, 'retry')
  assert.equal(JSON.stringify(retry.diagnostics).includes('SECRET'), false)
  retry.manager.dispose()

  const blocked = fixture(async () => {
    throw new GmailMetadataFailure('invalid_response')
  })
  await blocked.manager.connect(accountId, baseNow)
  assert.deepEqual(structuredClone(blocked.diagnostics[0]), {
    accountId,
    status: 'blocked',
    nextAttemptAt: null,
    code: 'invalid_response'
  })
  blocked.manager.dispose()
})
