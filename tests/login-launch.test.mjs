import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createLoginLaunchController } = loadTypeScript(
  new URL('../src/main/login-launch.ts', import.meta.url)
)

test('reads OS registration without mutating it and maps absent registration to disabled', async () => {
  const writes = []
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: (settings) => writes.push(settings)
  })
  assert.deepEqual(
    { ...(await controller.getState()) },
    {
      supported: true,
      enabled: false,
      status: 'disabled'
    }
  )
  assert.deepEqual(writes, [])
})

test('enable writes then reports actual OS readback', async () => {
  let enabled = false
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: (settings) => {
      enabled = settings.openAtLogin
    }
  })
  assert.deepEqual(
    { ...(await controller.setEnabled(true)) },
    {
      supported: true,
      enabled: true,
      status: 'enabled'
    }
  )
})

test('enable cancellation reads OS state without registering', async () => {
  let enabled = false
  let writes = 0
  let seen = false
  let confirmations = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      writes++
      enabled = openAtLogin
    },
    confirmEnable: async () => {
      confirmations++
      return false
    },
    promptSeen: () => seen,
    markPromptSeen: () => {
      seen = true
    }
  })
  assert.deepEqual(
    { ...(await controller.setEnabled(true)) },
    {
      supported: true,
      enabled: false,
      status: 'disabled'
    }
  )
  assert.equal(writes, 0)
  assert.equal(seen, true)
  assert.equal((await controller.setEnabled(true)).status, 'enabled')
  assert.equal(confirmations, 1)
  assert.equal(writes, 1)
})

test('enable confirmation registers after user approval', async () => {
  let enabled = false
  let seen = false
  let confirmations = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    },
    confirmEnable: async () => {
      confirmations++
      return true
    },
    promptSeen: () => seen,
    markPromptSeen: () => {
      seen = true
    }
  })
  assert.equal((await controller.setEnabled(true)).status, 'enabled')
  assert.equal(confirmations, 1)
  assert.equal(seen, true)
})

test('prompt persistence failure blocks registration', async () => {
  let writes = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => writes++,
    confirmEnable: async () => true,
    promptSeen: () => false,
    markPromptSeen: () => {
      throw new Error('disk failure')
    }
  })
  await assert.rejects(controller.setEnabled(true), /disk failure/)
  assert.equal(writes, 0)
})

test('disable does not ask for confirmation', async () => {
  let enabled = true
  let confirmations = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    },
    confirmEnable: async () => {
      confirmations++
      return true
    }
  })
  assert.equal((await controller.setEnabled(false)).status, 'disabled')
  assert.equal(confirmations, 0)
})

test('concurrent enable requests share one confirmation and registration', async () => {
  let enabled = false
  let writes = 0
  let resolveConfirmation
  const confirmation = new Promise((resolve) => {
    resolveConfirmation = resolve
  })
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      writes++
      enabled = openAtLogin
    },
    confirmEnable: () => confirmation
  })
  const first = controller.setEnabled(true)
  const second = controller.setEnabled(true)
  resolveConfirmation(true)
  assert.equal((await first).status, 'enabled')
  assert.equal((await second).status, 'enabled')
  assert.equal(writes, 1)
})

test('destroyed owner after confirmation prevents registration', async () => {
  let alive = true
  let writes = 0
  let marks = 0
  let resolveConfirmation
  const confirmation = new Promise((resolve) => {
    resolveConfirmation = resolve
  })
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => writes++,
    confirmEnable: () => confirmation,
    promptSeen: () => false,
    markPromptSeen: () => marks++,
    ownerAlive: () => alive
  })
  const pending = controller.setEnabled(true)
  alive = false
  resolveConfirmation(true)
  assert.equal((await pending).status, 'disabled')
  assert.equal(writes, 0)
  assert.equal(marks, 0)
})

test('an already answered prompt is skipped on later explicit enable', async () => {
  let enabled = false
  let confirmations = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    },
    confirmEnable: async () => {
      confirmations++
      return true
    },
    promptSeen: () => true
  })
  assert.equal((await controller.setEnabled(true)).status, 'enabled')
  assert.equal(confirmations, 0)
})

test('an invalidated confirmation result is not persisted', async () => {
  let marks = 0
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => assert.fail('must not register'),
    confirmEnable: async () => undefined,
    promptSeen: () => false,
    markPromptSeen: () => marks++
  })
  assert.equal((await controller.setEnabled(true)).status, 'disabled')
  assert.equal(marks, 0)
})

test('explicit disable while confirmation is open supersedes pending enable', async () => {
  let enabled = false
  const writes = []
  let resolveConfirmation
  const confirmation = new Promise((resolve) => {
    resolveConfirmation = resolve
  })
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      writes.push(openAtLogin)
      enabled = openAtLogin
    },
    confirmEnable: () => confirmation
  })
  const pendingEnable = controller.setEnabled(true)
  const disabled = await controller.setEnabled(false)
  resolveConfirmation(true)
  assert.equal(disabled.status, 'disabled')
  assert.equal((await pendingEnable).status, 'disabled')
  assert.deepEqual(writes, [false])
})

test('approval required is reported distinctly and cannot claim a confirmed disable', async () => {
  let enabled = true
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: enabled, status: 'requires-approval' }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    }
  })
  assert.deepEqual(
    { ...(await controller.getState()) },
    { supported: true, enabled: true, status: 'requires_approval' }
  )
  await assert.rejects(controller.setEnabled(false), /not applied/)
})

test('silent registration failure is surfaced instead of reporting enabled', async () => {
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => undefined
  })
  await assert.rejects(controller.setEnabled(true), /not applied/)
})

test('unsupported platforms never inspect or mutate OS login settings', async () => {
  let calls = 0
  const controller = createLoginLaunchController({
    supported: false,
    getLoginItemSettings: () => {
      calls++
      throw new Error('must not read')
    },
    setLoginItemSettings: () => {
      calls++
      throw new Error('must not write')
    }
  })
  assert.deepEqual(
    { ...(await controller.getState()) },
    { supported: false, enabled: false, status: 'unavailable' }
  )
  assert.deepEqual(
    { ...(await controller.setEnabled(true)) },
    { supported: false, enabled: false, status: 'unavailable' }
  )
  assert.equal(calls, 0)
})

test('disable reports confirmed OS state', async () => {
  let enabled = true
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    }
  })
  assert.deepEqual(
    { ...(await controller.setEnabled(false)) },
    { supported: true, enabled: false, status: 'disabled' }
  )
})

test('not-found registration can be attempted and remains actionable when it persists', async () => {
  let writes = 0
  const notFound = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-found' }),
    setLoginItemSettings: () => {
      writes++
    }
  })
  assert.deepEqual(
    { ...(await notFound.getState()) },
    { supported: true, enabled: false, status: 'not_found' }
  )
  assert.equal(writes, 0)
  await assert.rejects(notFound.setEnabled(true), /not applied/)
  await assert.rejects(notFound.setEnabled(false), /not applied/)
  assert.equal(writes, 2)
})

test('not-found registration may transition to enabled or approval pending', async () => {
  for (const [status, expected] of [
    ['enabled', 'enabled'],
    ['requires-approval', 'requires_approval']
  ]) {
    let currentStatus = 'not-found'
    const controller = createLoginLaunchController({
      supported: true,
      getLoginItemSettings: () => ({
        openAtLogin: currentStatus !== 'not-registered',
        status: currentStatus
      }),
      setLoginItemSettings: ({ openAtLogin }) => {
        if (openAtLogin) currentStatus = status
      }
    })
    assert.deepEqual(
      { ...(await controller.setEnabled(true)) },
      { supported: true, enabled: true, status: expected }
    )
  }
})

test('unknown OS status remains unavailable and OS boundary errors propagate', async () => {
  const unavailable = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'future-status' }),
    setLoginItemSettings: () => undefined
  })
  assert.deepEqual(
    { ...(await unavailable.getState()) },
    { supported: true, enabled: false, status: 'unavailable' }
  )
  await assert.rejects(unavailable.setEnabled(true), /not applied/)
  const readFailure = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => {
      throw new Error('read')
    },
    setLoginItemSettings: () => undefined
  })
  await assert.rejects(readFailure.getState(), /read/)
  const writeFailure = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => {
      throw new Error('write')
    }
  })
  await assert.rejects(writeFailure.setEnabled(true), /write/)
})

test('login diagnostics capture safe OS status and preserve operation failures', async () => {
  const events = []
  const notFound = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-found' }),
    setLoginItemSettings: () => undefined,
    onDiagnostic: (event) => events.push(event)
  })
  await notFound.getState()
  assert.deepEqual(structuredClone(events), [
    {
      type: 'login.launch',
      operation: 'read',
      status: 'not-found',
      openAtLogin: false,
      outcome: 'success'
    }
  ])

  const original = new Error('private path /Users/person')
  const readFailure = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => {
      throw original
    },
    setLoginItemSettings: () => undefined,
    onDiagnostic: (event) => events.push(event)
  })
  await assert.rejects(readFailure.getState(), (error) => error === original)
  assert.deepEqual(structuredClone(events.at(-1)), {
    type: 'login.launch',
    operation: 'read',
    status: 'missing',
    outcome: 'failure'
  })
})

test('login diagnostics distinguish write failure, readback failure, mismatch and success', async () => {
  const events = []
  const writeError = new Error('private write details')
  const writeFailure = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => {
      throw writeError
    },
    onDiagnostic: (event) => events.push(event)
  })
  await assert.rejects(writeFailure.setEnabled(true), (error) => error === writeError)
  assert.deepEqual(structuredClone(events), [
    { type: 'login.launch', operation: 'set', requestedEnabled: true, outcome: 'failure' }
  ])

  events.length = 0
  let reads = 0
  const readbackError = new Error('private readback details')
  const readbackFailure = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => {
      reads++
      if (reads === 1) throw readbackError
      return { openAtLogin: false, status: 'not-registered' }
    },
    setLoginItemSettings: () => undefined,
    onDiagnostic: (event) => events.push(event)
  })
  await assert.rejects(readbackFailure.setEnabled(true), (error) => error === readbackError)
  assert.deepEqual(
    events.map(({ operation, outcome }) => [operation, outcome]),
    [
      ['set', 'returned'],
      ['readback', 'failure']
    ]
  )

  events.length = 0
  const mismatch = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-registered' }),
    setLoginItemSettings: () => undefined,
    onDiagnostic: (event) => events.push(event)
  })
  await assert.rejects(mismatch.setEnabled(true), /not applied/)
  assert.equal(events.at(-1).operation, 'readback')
  assert.equal(events.at(-1).outcome, 'mismatch')
  assert.equal(events.at(-1).requestedEnabled, true)

  events.length = 0
  let enabled = false
  const success = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    },
    onDiagnostic: (event) => events.push(event)
  })
  await success.setEnabled(true)
  assert.deepEqual(
    events.map(({ operation, outcome }) => [operation, outcome]),
    [
      ['set', 'returned'],
      ['readback', 'success']
    ]
  )
})

test('diagnostic callback failures never interrupt login-item operations', async () => {
  let enabled = false
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: ({ openAtLogin }) => {
      enabled = openAtLogin
    },
    onDiagnostic: () => {
      throw new Error('private diagnostic failure')
    }
  })
  assert.equal((await controller.setEnabled(true)).enabled, true)
})

test('each refresh reads the current external OS registration', async () => {
  let enabled = false
  const controller = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({
      openAtLogin: enabled,
      status: enabled ? 'enabled' : 'not-registered'
    }),
    setLoginItemSettings: () => undefined
  })
  assert.equal((await controller.getState()).enabled, false)
  enabled = true
  assert.equal((await controller.getState()).enabled, true)
})
