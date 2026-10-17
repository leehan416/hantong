/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test helpers use inferred JavaScript return types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { AccountAccessController, GoogleConnectionController } = loadTypeScript(
  new URL('../src/renderer/src/google-connection-controller.ts', import.meta.url)
)

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function status(accountId, value) {
  return { accountId, status: value }
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve))
}

test('late status response for the old account cannot replace the selected account', async () => {
  const oldRead = deferred()
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: (accountId) =>
        accountId === 'first' ? oldRead.promise : Promise.resolve(status('second', 'connected')),
      connectGoogleAccount: async () => status('first', 'connected'),
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  controller.selectAccount('second')
  await tick()
  oldRead.resolve(status('first', 'disconnected'))
  await tick()

  assert.equal(states.at(-1).accountId, 'second')
  assert.equal(states.at(-1).status, 'connected')
})

test('cancel invalidates a pending connect response and prevents duplicate connects', async () => {
  const connectRead = deferred()
  let connectCalls = 0
  let cancelCalls = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => status('first', 'disconnected'),
      connectGoogleAccount: () => {
        connectCalls += 1
        return connectRead.promise
      },
      cancelGoogleConnection: async () => {
        cancelCalls += 1
        return status('first', 'disconnected')
      },
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  const firstConnect = controller.connect()
  const duplicateConnect = controller.connect()
  assert.equal(connectCalls, 1)

  await controller.cancel()
  connectRead.resolve(status('first', 'connected'))
  await Promise.all([firstConnect, duplicateConnect])

  assert.equal(cancelCalls, 1)
  assert.equal(states.at(-1).status, 'disconnected')
  assert.equal(states.at(-1).operation, null)
})

test('status read failure stays unknown and retries status without starting OAuth', async () => {
  let reads = 0
  let connects = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => {
        reads += 1
        if (reads === 1) throw new Error('unavailable')
        return status('first', 'disconnected')
      },
      connectGoogleAccount: async () => {
        connects += 1
        return status('first', 'connected')
      },
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  assert.equal(states.at(-1).status, null)
  assert.equal(states.at(-1).readFailed, true)
  await controller.connect()
  assert.equal(connects, 0)

  await controller.refresh()
  assert.equal(reads, 2)
  assert.equal(states.at(-1).status, 'disconnected')
  assert.equal(states.at(-1).readFailed, false)
})

test('status refresh error response stays unknown instead of offering OAuth', async () => {
  let reads = 0
  let connects = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => {
        reads += 1
        return status('first', reads === 1 ? 'error' : 'disconnected')
      },
      connectGoogleAccount: async () => {
        connects += 1
        return status('first', 'connected')
      },
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  assert.equal(states.at(-1).status, null)
  assert.equal(states.at(-1).readFailed, true)
  await controller.connect()
  assert.equal(connects, 0)

  await controller.refresh()
  assert.equal(states.at(-1).status, 'disconnected')
})

test('disconnect error response stays unknown until status is checked again', async () => {
  let reads = 0
  let disconnects = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => {
        reads += 1
        return status('first', 'connected')
      },
      connectGoogleAccount: async () => status('first', 'connected'),
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => {
        disconnects += 1
        return status('first', 'error')
      }
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  await controller.disconnect()

  assert.equal(disconnects, 1)
  assert.equal(states.at(-1).status, null)
  assert.equal(states.at(-1).readFailed, true)

  await controller.refresh()
  assert.equal(reads, 2)
  assert.equal(states.at(-1).status, 'connected')
})

test('connect invalidates a status refresh without leaving its loading state behind', async () => {
  const staleRead = deferred()
  let reads = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: () => {
        reads += 1
        return reads === 1 ? Promise.resolve(status('first', 'disconnected')) : staleRead.promise
      },
      connectGoogleAccount: async () => status('first', 'connected'),
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  const refresh = controller.refresh()
  await controller.connect()
  staleRead.resolve(status('first', 'disconnected'))
  await refresh

  assert.equal(states.at(-1).status, 'connected')
  assert.equal(states.at(-1).loading, false)
})

test('disposed controller ignores late mutation completion', async () => {
  const connectRead = deferred()
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => status('first', 'disconnected'),
      connectGoogleAccount: () => connectRead.promise,
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )
  controller.selectAccount('first')
  await tick()
  const connect = controller.connect()
  controller.dispose()
  const stateCount = states.length
  connectRead.resolve(status('first', 'connected'))
  await connect

  assert.equal(states.length, stateCount)
})

test('Main access event invalidates an older access snapshot', async () => {
  const snapshot = deferred()
  const states = []
  const connectionStates = []
  let listener
  const controller = new AccountAccessController(
    {
      onAccountAccessState: (callback) => {
        listener = callback
        return () => {}
      },
      getAccountAccessState: () => snapshot.promise
    },
    (state) => states.push(state),
    (state) => connectionStates.push(state)
  )

  controller.selectAccount('first')
  listener({ accountId: 'first', status: 'ready', connectionStatus: 'connected' })
  snapshot.resolve({ accountId: 'first', status: 'required', connectionStatus: 'disconnected' })
  await tick()

  assert.equal(states.at(-1).state.status, 'ready')
  assert.equal(connectionStates.at(-1).status, 'ready')
  controller.dispose()
})

test('access controller ignores responses from the previous account', async () => {
  const oldSnapshot = deferred()
  const states = []
  const controller = new AccountAccessController(
    {
      onAccountAccessState: () => () => {},
      getAccountAccessState: (accountId) =>
        accountId === 'first'
          ? oldSnapshot.promise
          : Promise.resolve({ accountId, status: 'required', connectionStatus: 'disconnected' })
    },
    (state) => states.push(state),
    () => {}
  )

  controller.selectAccount('first')
  controller.selectAccount('second')
  await tick()
  oldSnapshot.resolve({ accountId: 'first', status: 'ready', connectionStatus: 'connected' })
  await tick()

  assert.equal(states.at(-1).accountId, 'second')
  assert.equal(states.at(-1).state.status, 'required')
  controller.dispose()
})

test('external Main connection status enables cancellation of automatic OAuth', async () => {
  const states = []
  let cancelCalls = 0
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => status('first', 'disconnected'),
      connectGoogleAccount: async () => status('first', 'connected'),
      cancelGoogleConnection: async () => {
        cancelCalls += 1
        return status('first', 'disconnected')
      },
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  controller.applyExternalStatus(status('first', 'connecting'))
  await controller.cancel()

  assert.equal(cancelCalls, 1)
  assert.equal(states.at(-1).status, 'disconnected')
  assert.equal(states.at(-1).operation, null)
})

for (const terminalStatus of ['connected', 'error']) {
  test(`external automatic OAuth ${terminalStatus} status clears its busy state`, async () => {
    const states = []
    const controller = new GoogleConnectionController(
      {
        getGoogleConnectionStatus: async () => status('first', 'disconnected'),
        connectGoogleAccount: async () => status('first', 'connected'),
        cancelGoogleConnection: async () => status('first', 'disconnected'),
        disconnectGoogleAccount: async () => status('first', 'disconnected')
      },
      (state) => states.push(state)
    )

    controller.selectAccount('first')
    await tick()
    controller.applyExternalStatus(status('first', 'connecting'))
    assert.equal(states.at(-1).operation, null)
    controller.applyExternalStatus(status('first', terminalStatus))

    assert.equal(states.at(-1).status, terminalStatus)
    assert.equal(states.at(-1).operation, null)
  })
}

test('gate retry can revalidate a connected grant while regular connect stays guarded', async () => {
  let connectCalls = 0
  const states = []
  const controller = new GoogleConnectionController(
    {
      getGoogleConnectionStatus: async () => status('first', 'connected'),
      connectGoogleAccount: async () => {
        connectCalls += 1
        return status('first', 'connected')
      },
      cancelGoogleConnection: async () => status('first', 'disconnected'),
      disconnectGoogleAccount: async () => status('first', 'disconnected')
    },
    (state) => states.push(state)
  )

  controller.selectAccount('first')
  await tick()
  await controller.connect()
  assert.equal(connectCalls, 0)
  await controller.connect(true)

  assert.equal(connectCalls, 1)
  assert.equal(states.at(-1).status, 'connected')
})

test('access subscription failure is contained and status snapshots remain queryable', async () => {
  const states = []
  const controller = new AccountAccessController(
    {
      onAccountAccessState: () => {
        throw new Error('subscription unavailable')
      },
      getAccountAccessState: async (accountId) => ({
        accountId,
        status: 'required',
        connectionStatus: 'disconnected'
      })
    },
    (state) => states.push(state),
    () => {}
  )

  controller.selectAccount('first')
  assert.equal(states.at(-1).readFailed, true)
  await tick()

  assert.equal(states.at(-1).readFailed, false)
  assert.equal(states.at(-1).state.status, 'required')
  controller.dispose()
})
