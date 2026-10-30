/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

function fixture({ failCleanup = false } = {}) {
  let state = {
    version: 1,
    accounts: [{ id: firstId }, { id: secondId }],
    activeAccountId: firstId
  }
  let fail = failCleanup
  const events = []
  const controllerModule = loadTypeScript(
    new URL('../src/main/account-removal.ts', import.meta.url)
  )
  const controller = controllerModule.createAccountRemovalController(
    {
      getState: () => structuredClone(state),
      remove(id) {
        const accounts = state.accounts.filter((account) => account.id !== id)
        const activeAccountId =
          state.activeAccountId === id ? (accounts[0]?.id ?? null) : state.activeAccountId
        state = { version: 1, accounts, activeAccountId }
        events.push('persist')
        return structuredClone(state)
      }
    },
    async () => {
      events.push('cleanup')
      if (fail) {
        fail = false
        throw new Error('simulated cleanup failure')
      }
    }
  )
  const context = {
    ownerIsAlive: () => true,
    confirm: async (number) => {
      events.push(`confirm:${number}`)
      return true
    },
    disposeView: async (id) => events.push(`dispose:${id}`),
    activate: (id) => events.push(`activate:${id}`)
  }
  return { controller, context, events, getState: () => structuredClone(state) }
}

test('cancelled removal leaves account state and views untouched', async () => {
  const fixtureData = fixture()
  fixtureData.context.confirm = async () => false
  const result = await fixtureData.controller.remove(firstId, fixtureData.context)
  assert.equal(result.outcome, 'cancelled')
  assert.deepEqual(result.state, fixtureData.getState())
  assert.deepEqual(fixtureData.events, [])
})

test('account removal disconnects the API grant after view disposal and before session clearing', async () => {
  const events = []
  let state = {
    version: 1,
    accounts: [{ id: firstId }],
    activeAccountId: firstId
  }
  const { createAccountRemovalController } = loadTypeScript(
    new URL('../src/main/account-removal.ts', import.meta.url)
  )
  const controller = createAccountRemovalController(
    {
      getState: () => structuredClone(state),
      remove: () => {
        events.push('persist')
        state = { version: 1, accounts: [], activeAccountId: null }
        return structuredClone(state)
      }
    },
    async () => events.push('clear-session'),
    async () => events.push('disconnect-api')
  )
  const result = await controller.remove(firstId, {
    ownerIsAlive: () => true,
    confirm: async () => true,
    disposeView: async () => events.push('dispose-view'),
    activate: () => undefined
  })
  assert.equal(result.outcome, 'removed')
  assert.deepEqual(events, ['dispose-view', 'disconnect-api', 'clear-session', 'persist'])
})

test('failed API disconnection keeps account metadata and does not clear the web session', async () => {
  const events = []
  let state = {
    version: 1,
    accounts: [{ id: firstId }],
    activeAccountId: firstId
  }
  const { createAccountRemovalController } = loadTypeScript(
    new URL('../src/main/account-removal.ts', import.meta.url)
  )
  const controller = createAccountRemovalController(
    {
      getState: () => structuredClone(state),
      remove: () => {
        events.push('persist')
        state = { version: 1, accounts: [], activeAccountId: null }
        return structuredClone(state)
      }
    },
    async () => events.push('clear-session'),
    async () => {
      events.push('disconnect-api')
      throw new Error('private storage failure')
    }
  )
  const result = await controller.remove(firstId, {
    ownerIsAlive: () => true,
    confirm: async () => true,
    disposeView: async () => events.push('dispose-view'),
    activate: () => undefined
  })
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(result.state.accounts, [{ id: firstId }])
  assert.deepEqual(events, ['dispose-view', 'disconnect-api'])
})

test('cleanup failure retains metadata and a later retry activates fallback after persistence', async () => {
  const fixtureData = fixture({ failCleanup: true })
  const failed = await fixtureData.controller.remove(firstId, fixtureData.context)
  assert.equal(failed.outcome, 'failed')
  assert.deepEqual(failed.state, fixtureData.getState())
  assert.equal(fixtureData.controller.isBusy(), false)
  fixtureData.events.length = 0
  const retried = await fixtureData.controller.remove(firstId, fixtureData.context)
  assert.equal(retried.outcome, 'removed')
  assert.deepEqual(retried.state, {
    version: 1,
    accounts: [{ id: secondId }],
    activeAccountId: secondId
  })
  assert.deepEqual(fixtureData.events, [
    'confirm:1',
    `dispose:${firstId}`,
    'cleanup',
    'persist',
    `activate:${secondId}`
  ])
})

test('while confirmation is pending, account operations are rejected', async () => {
  const fixtureData = fixture()
  let resolveConfirmation
  fixtureData.context.confirm = () => new Promise((resolve) => (resolveConfirmation = resolve))
  const pending = fixtureData.controller.remove(firstId, fixtureData.context)
  assert.equal(fixtureData.controller.isBusy(), true)
  assert.throws(() => fixtureData.controller.assertIdle(), /Request rejected/)
  await assert.rejects(
    fixtureData.controller.remove(secondId, fixtureData.context),
    /Request rejected/
  )
  resolveConfirmation(false)
  await pending
  assert.equal(fixtureData.controller.isBusy(), false)
})

test('logout removals coalesce duplicate accounts and wait behind manual removal', async () => {
  const fixtureData = fixture()
  let finishManual
  fixtureData.context.confirm = () => new Promise((resolve) => (finishManual = resolve))
  const manual = fixtureData.controller.remove(firstId, fixtureData.context)
  fixtureData.context.confirm = async () => true
  const firstLogout = fixtureData.controller.removeWhenIdle(firstId, fixtureData.context)
  const duplicate = fixtureData.controller.removeWhenIdle(firstId, fixtureData.context)
  const secondLogout = fixtureData.controller.removeWhenIdle(secondId, fixtureData.context)
  assert.equal(firstLogout, duplicate)
  finishManual(false)
  assert.equal((await manual).outcome, 'cancelled')
  assert.equal((await firstLogout).outcome, 'removed')
  assert.equal((await secondLogout).outcome, 'removed')
  assert.deepEqual(fixtureData.getState().accounts, [])
  assert.equal(fixtureData.controller.isBusy(), false)
})

test('queued logout cleanup failure leaves the account for an explicit retry', async () => {
  const fixtureData = fixture({ failCleanup: true })
  const result = await fixtureData.controller.removeWhenIdle(firstId, fixtureData.context)
  assert.equal(result.outcome, 'failed')
  assert.deepEqual(fixtureData.getState().accounts, [{ id: firstId }, { id: secondId }])
  assert.equal(fixtureData.controller.isBusy(), false)
})

test('session cleanup waits for target view destruction before clearing its partition', async () => {
  const fixtureData = fixture()
  let finishDisposal
  fixtureData.context.disposeView = (id) => {
    fixtureData.events.push(`dispose:${id}`)
    return new Promise((resolve) => (finishDisposal = resolve))
  }
  const pending = fixtureData.controller.remove(firstId, fixtureData.context)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fixtureData.events, ['confirm:1', `dispose:${firstId}`])
  assert.equal(fixtureData.controller.isBusy(), true)
  finishDisposal()
  const result = await pending
  assert.equal(result.outcome, 'removed')
  assert.ok(
    fixtureData.events.indexOf('cleanup') > fixtureData.events.indexOf('dispose:' + firstId)
  )
})

test('a closed owner after confirmation prevents native cleanup and view changes', async () => {
  const fixtureData = fixture()
  let alive = true
  fixtureData.context.ownerIsAlive = () => alive
  fixtureData.context.confirm = async () => {
    alive = false
    return true
  }
  const result = await fixtureData.controller.remove(firstId, fixtureData.context)
  assert.equal(result.outcome, 'cancelled')
  assert.deepEqual(fixtureData.events, [])
})

test('session cleanup closes connections and clears only the requested account partition', async () => {
  const calls = []
  const { createAccountSessionCleaner } = loadTypeScript(
    new URL('../src/main/account-session-cleanup.ts', import.meta.url),
    { './account-session': { getAccountSession: (id) => id } }
  )
  const clean = createAccountSessionCleaner((id) => ({
    closeAllConnections: async () => calls.push(`${id}:connections`),
    clearStorageData: async () => calls.push(`${id}:storage`),
    clearCache: async () => calls.push(`${id}:cache`),
    clearAuthCache: async () => calls.push(`${id}:auth`)
  }))
  await clean(firstId)
  assert.deepEqual(calls, [
    `${firstId}:connections`,
    `${firstId}:storage`,
    `${firstId}:cache`,
    `${firstId}:auth`
  ])
})
