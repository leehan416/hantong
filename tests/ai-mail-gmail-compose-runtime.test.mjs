/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test doubles are plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailComposeProbeRuntime } = loadTypeScript(
  new URL('../src/main/gmail-compose-probe.ts', import.meta.url)
)

function createRuntimeFixture(options = {}) {
  let accessStatus = 'required'
  let granted = false
  const executed = []
  const listeners = new Map()
  const contents = {
    id: 404,
    isDestroyed: () => false,
    on(event, listener) {
      listeners.set(event, listener)
      return this
    },
    removeListener(event) {
      listeners.delete(event)
      return this
    },
    executeJavaScriptInIsolatedWorld(worldId, scripts) {
      const code = scripts[0].code
      executed.push({ worldId, code })
      if (code.includes('.lastTarget()')) return Promise.resolve('compose-target')
      if (code.includes('.hasTarget(')) return Promise.resolve(true)
      if (code.includes('.read('))
        return Promise.resolve({
          subject: 'synthetic subject marker',
          body: 'synthetic body marker',
          supported: true,
          reason: null
        })
      if (options.installError && code.includes('__hantongGmailComposeProbe'))
        return Promise.reject(options.installError)
      if (options.installResult !== undefined && code.includes('__hantongGmailComposeProbe'))
        return Promise.resolve(options.installResult)
      options.onInstall?.()
      return Promise.resolve(true)
    }
  }
  let pendingLine
  const terminal = {
    question(_prompt, callback) {
      pendingLine = callback
    },
    on() {
      return this
    },
    close() {
      return this
    },
    answer(line) {
      const callback = pendingLine
      pendingLine = null
      callback(line)
    }
  }
  const runtime = createGmailComposeProbeRuntime({
    window: { isDestroyed: () => false },
    views: {
      getActiveAccountId: () => 'authorized-test-account',
      getComposeProbeView: () =>
        granted ? { contents, navigationRevision: 3, accessRevision: 7 } : null
    },
    access: { getState: () => ({ status: accessStatus }) },
    accountExists: () => true,
    isPackaged: false,
    argv: ['--gmail-compose-probe'],
    terminal
  })
  return {
    runtime,
    contents,
    executed,
    listeners,
    terminal,
    setAccess(status, accessGranted) {
      accessStatus = status
      granted = accessGranted
    },
    async command(value) {
      terminal.answer(value)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

test('runtime requires the real Main access state before it installs or uses the probe', async () => {
  const fixture = createRuntimeFixture()
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.executed.length, 0)

  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.executed.length, 1)
  assert.equal(fixture.executed[0].worldId, 7913)
  assert.ok(fixture.listeners.has('did-start-navigation'))
  await fixture.command('read')
  const beforeRevocation = fixture.executed.length

  fixture.setAccess('required', false)
  fixture.runtime.onAccessState({
    accountId: 'authorized-test-account',
    status: 'required',
    connectionStatus: 'disconnected'
  })
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('replace-sample')
  await fixture.command('undo')
  assert.equal(fixture.executed.length, beforeRevocation + 1)
  assert.ok(fixture.executed.at(-1).code.includes('.revoke()'))
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.replace(')))
  fixture.runtime.dispose()
})

test('runtime remains locked when isolated-world probe installation rejects', async () => {
  const fixture = createRuntimeFixture({ installError: new Error('synthetic install rejection') })
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('read')
  assert.ok(fixture.executed.length >= 1)
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.lastTarget()')))
  fixture.runtime.dispose()
})

test('runtime revokes a stale installation when the access context changes while awaiting it', async () => {
  let fixture
  fixture = createRuntimeFixture({
    onInstall() {
      fixture.setAccess('required', false)
    }
  })
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('read')
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.lastTarget()')))
  fixture.runtime.dispose()
})

test('read-only runtime page source exposes no DOM mutation operation', async () => {
  const fixture = createRuntimeFixture()
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  const source = fixture.executed[0].code
  assert.ok(source.includes('revoke()'))
  assert.match(source, /3:7:0:[0-9a-f-]{36}/)
  assert.ok(!source.includes('execCommand'))
  assert.ok(!source.includes('insertText'))
  assert.ok(!source.includes('replace(id'))
  fixture.runtime.dispose()
})

test('runtime refuses packaged builds even when the probe flag is present', () => {
  assert.throws(() =>
    createGmailComposeProbeRuntime({
      window: { isDestroyed: () => false },
      views: {},
      access: {},
      accountExists: () => true,
      isPackaged: true,
      argv: ['--gmail-compose-probe'],
      terminal: {}
    })
  )
})
