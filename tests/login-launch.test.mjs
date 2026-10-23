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

test('not-found and OS boundary errors fail honestly', async () => {
  const unavailable = createLoginLaunchController({
    supported: true,
    getLoginItemSettings: () => ({ openAtLogin: false, status: 'not-found' }),
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
