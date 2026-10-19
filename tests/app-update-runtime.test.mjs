/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use JavaScript fixtures. */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

class FakeUpdater extends EventEmitter {
  autoDownload = false
  autoInstallOnAppQuit = true
  allowDowngrade = true
  allowPrerelease = false
  checkForUpdates = async () => null
  quitAndInstall = () => {
    this.installs += 1
  }
  installs = 0
  // AppUpdater keeps its own logging listener, so errors after dispose never throw.
  constructor() {
    super()
    this.on('error', () => undefined)
  }
}

function fixture(nativeResult = 'error', enabled = true) {
  const updater = new FakeUpdater()
  const dialogs = []
  const nativeUpdater = new EventEmitter()
  // MacUpdater permanently forwards native errors; without it a late native error throws.
  nativeUpdater.on('error', (error) => updater.emit('error', error))
  let stageChecks = 0
  nativeUpdater.checkForUpdates = () => {
    stageChecks += 1
    if (nativeResult === 'sync-then-downloaded' && stageChecks === 1)
      throw new Error('native updater unavailable')
    setImmediate(() => {
      if (nativeResult === 'error') nativeUpdater.emit('error', new Error('signature rejection'))
      else if (nativeResult === 'double-error') {
        const error = new Error('signature rejection')
        updater.emit('error', error)
        nativeUpdater.emit('error', error)
      } else if (nativeResult === 'downloaded' || nativeResult === 'sync-then-downloaded')
        nativeUpdater.emit('update-downloaded')
    })
  }
  const electron = {
    autoUpdater: nativeUpdater,
    dialog: {
      showMessageBox: async (...args) => {
        dialogs.push(args)
        return { response: 1 }
      }
    }
  }
  const runtime = loadTypeScript(new URL('../src/main/app-update-runtime.ts', import.meta.url), {
    electron,
    'electron-updater': { autoUpdater: updater }
  })
  let cleanups = 0
  const instance = runtime.createAppUpdateRuntime({
    enabled,
    version: '0.1.0-alpha.1',
    locale: () => 'en',
    parentWindow: () => undefined,
    onStateChanged: () => undefined,
    prepareToInstall: async () => {
      cleanups += 1
    }
  })
  return {
    updater,
    dialogs,
    instance,
    nativeUpdater,
    stageChecks: () => stageChecks,
    cleanups: () => cleanups
  }
}

test('runtime keeps explicit install and prerelease policy', () => {
  const { updater, instance } = fixture()
  assert.equal(updater.autoDownload, true)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowDowngrade, false)
  assert.equal(updater.allowPrerelease, true)
  instance.dispose()
})

test('native staging failure preserves the running app and skips cleanup', async () => {
  const { updater, instance, stageChecks, cleanups } = fixture()
  updater.emit('update-available', { version: '0.1.0-alpha.2' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.2' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stageChecks(), 1)
  assert.equal(cleanups(), 0)
  assert.equal(updater.installs, 0)
  instance.dispose()
})

test('the same native staging error forwarded through both updater paths shows once', async () => {
  const { updater, instance, cleanups, dialogs } = fixture('double-error')
  updater.emit('update-available', { version: '0.1.0-alpha.2' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.2' })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const failures = dialogs.filter((args) => args[0].message.includes('problem updating'))
  assert.equal(failures.length, 1)
  assert.equal(instance.controller.state.kind, 'ready')
  assert.equal(cleanups(), 0)
  assert.equal(updater.installs, 0)
  instance.dispose()
})

test('verified native staging completes cleanup before one explicit install', async () => {
  const { updater, instance, stageChecks, cleanups } = fixture('downloaded')
  updater.emit('update-available', { version: '0.1.0-alpha.2' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.2' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(stageChecks(), 1)
  assert.equal(cleanups(), 1)
  assert.equal(updater.installs, 1)
  instance.dispose()
})

test('disposed runtime cancels native staging and prevents later cleanup', async () => {
  const { updater, instance, nativeUpdater, cleanups } = fixture('pending')
  updater.emit('update-available', { version: '0.1.0-alpha.2' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.2' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(nativeUpdater.listenerCount('update-downloaded'), 1)
  instance.dispose()
  assert.equal(nativeUpdater.listenerCount('update-downloaded'), 0)
  assert.equal(cleanups(), 0)
})

test('disabled runtime does not attach native updater listeners', () => {
  const { instance, nativeUpdater } = fixture('pending', false)
  instance.dispose()
  assert.equal(nativeUpdater.listenerCount('update-downloaded'), 0)
  // Only the fixture's MacUpdater forwarder remains.
  assert.equal(nativeUpdater.listenerCount('error'), 1)
})

test('synchronous native check failure removes listeners and permits retry', async () => {
  const { updater, instance, nativeUpdater, stageChecks, cleanups } =
    fixture('sync-then-downloaded')
  updater.emit('update-available', { version: '0.1.0-alpha.2' })
  updater.emit('update-downloaded', { version: '0.1.0-alpha.2' })
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stageChecks(), 1)
  assert.equal(nativeUpdater.listenerCount('update-downloaded'), 0)
  assert.equal(cleanups(), 0)
  await instance.controller.restart()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stageChecks(), 2)
  assert.equal(cleanups(), 1)
  assert.equal(updater.installs, 1)
  instance.dispose()
})
