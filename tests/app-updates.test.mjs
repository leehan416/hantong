/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createAppUpdateController } = loadTypeScript(
  new URL('../src/main/app-updates.ts', import.meta.url)
)

function fixture(options = {}) {
  const listeners = new Map()
  const timers = []
  const calls = { checks: 0, installs: 0, dialogs: [], states: [], removed: [] }
  let resolveCheck
  let rejectCheck
  const deps = {
    enabled: options.enabled ?? true,
    updater: {
      checkForUpdates: () => {
        calls.checks += 1
        return options.check
          ? options.check()
          : options.deferred
            ? new Promise((resolve, reject) => {
                resolveCheck = resolve
                rejectCheck = reject
              })
            : Promise.resolve()
      },
      quitAndInstall: () => {
        calls.installs += 1
        options.quitAndInstall?.()
      },
      on: (event, listener) => listeners.set(event, listener),
      off: (event, listener) => {
        calls.removed.push([event, listener])
        if (listeners.get(event) === listener) listeners.delete(event)
      }
    },
    prepareToInstall: options.prepareToInstall ?? (async () => undefined),
    present:
      options.present ??
      (async (notice) => {
        calls.dialogs.push(notice)
        return 'later'
      }),
    stateChanged: (state) => calls.states.push(state),
    schedule: (callback, delay) => {
      const timer = { callback, delay, cleared: false }
      timers.push(timer)
      return timer
    },
    cancel: (timer) => {
      timer.cleared = true
    }
  }
  return {
    controller: createAppUpdateController(deps),
    listeners,
    timers,
    calls,
    resolveCheck: (...args) => resolveCheck?.(...args),
    rejectCheck: (...args) => rejectCheck?.(...args)
  }
}

test('disabled development does not check, subscribe, schedule, or dispose unrelated listeners', async () => {
  const f = fixture({ enabled: false })
  await f.controller.check(true)
  f.controller.dispose()
  assert.equal(f.calls.checks, 0)
  assert.equal(f.timers.length, 0)
  assert.equal(f.listeners.size, 0)
  assert.equal(f.calls.removed.length, 0)
  assert.equal(f.controller.state.kind, 'idle')
})

test('manual checks coalesce and retain manual intent when scheduled work is pending', async () => {
  const f = fixture({ deferred: true })
  const first = f.controller.check(false)
  const second = f.controller.check(true)
  assert.equal(f.calls.checks, 1)
  f.listeners.get('update-not-available')()
  f.resolveCheck()
  await Promise.all([first, second])
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'latest')
  assert.equal(f.controller.state.kind, 'idle')
})

test('manual check reports progress without starting another check during download', async () => {
  const f = fixture()
  const pending = f.controller.check(true)
  f.listeners.get('update-available')({ version: '0.2.0' })
  await f.controller.check(true)
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'progress')
  f.resolveCheck()
  await pending
  assert.equal(f.calls.checks, 1)
})

test('scheduled latest and failure outcomes stay silent', async () => {
  const f = fixture({ check: async () => undefined })
  await f.controller.check(false)
  assert.equal(f.calls.dialogs.length, 0)
  const failed = fixture({
    check: async () => {
      throw new Error('offline')
    }
  })
  await failed.controller.check(false)
  assert.equal(failed.calls.dialogs.length, 0)
  assert.equal(failed.controller.state.kind, 'failed')
})

test('manual intent survives check completion until a later download error', async () => {
  const f = fixture()
  const pending = f.controller.check(true)
  f.listeners.get('update-available')({ version: '0.2.0' })
  await pending
  f.listeners.get('error')(new Error('signature failed'))
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'failed')
  assert.equal(f.calls.dialogs[0].message, 'signature failed')
})

test('manual download failure intent does not leak into later scheduled checks', async () => {
  let attempts = 0
  const f = fixture({
    check: async () => {
      attempts += 1
      if (attempts === 3) throw new Error('scheduled offline')
    }
  })
  const manualCheck = f.controller.check(true)
  f.listeners.get('update-available')({ version: '0.2.0' })
  await manualCheck
  f.listeners.get('error')(new Error('download failed'))
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'failed')
  await f.controller.check(false)
  await f.controller.check(false)
  assert.equal(f.calls.dialogs.length, 1)
})

test('an event-only failure does not turn a resolved manual check into latest', async () => {
  const f = fixture({
    check: async () => {
      f.listeners.get('error')(new Error('network'))
    }
  })
  await f.controller.check(true)
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'failed')
})

test('download completion offers restart and installs only after accepted choice and cleanup', async () => {
  let resolveCleanup
  const f = fixture({
    present: async (notice) => {
      f.calls.dialogs.push(notice)
      return notice.kind === 'ready' ? 'restart' : 'later'
    },
    prepareToInstall: () =>
      new Promise((resolve) => {
        resolveCleanup = resolve
      })
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.state.kind, 'installing')
  assert.equal(f.calls.installs, 0)
  resolveCleanup()
  await pending
  await Promise.resolve()
  assert.equal(f.calls.installs, 1)
})

test('Later keeps the update ready and repeated downloaded events show one prompt', async () => {
  const f = fixture()
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  await Promise.resolve()
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'ready')
  assert.equal(f.calls.dialogs[0].version, '0.2.0')
  assert.equal(f.controller.state.kind, 'ready')
})

test('download completion for a different version cannot replace the active download', async () => {
  const f = fixture()
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.3.0' })
  assert.equal(f.controller.state.kind, 'downloading')
  assert.equal(f.calls.dialogs.length, 0)
  f.resolveCheck()
  await pending
})

test('rejected check and error event produce one manual failure notice and permit retry', async () => {
  let attempts = 0
  const f = fixture({
    check: async () => {
      attempts += 1
      if (attempts === 1) {
        f.listeners.get('error')(new Error('offline'))
        throw new Error('offline')
      }
    }
  })
  await f.controller.check(true)
  assert.equal(f.calls.dialogs.length, 1)
  assert.equal(f.calls.dialogs[0].kind, 'failed')
  assert.equal(f.calls.dialogs[0].message, 'offline')
  await f.controller.check(true)
  assert.equal(attempts, 2)
})

test('cleanup failure preserves ready version, reports failure, and allows retry', async () => {
  let attempts = 0
  const f = fixture({
    prepareToInstall: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('cleanup')
    }
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  await f.controller.restart()
  assert.equal(f.controller.state.kind, 'ready')
  assert.equal(f.controller.state.version, '0.2.0')
  assert.equal(f.calls.installs, 0)
  assert.equal(f.calls.dialogs.at(-1).kind, 'failed')
  assert.equal(f.calls.dialogs.at(-1).message, 'cleanup')
  await f.controller.restart()
  assert.equal(f.calls.installs, 1)
})

test('repeated restart requests during cleanup and after install invocation install once', async () => {
  let resolveCleanup
  const f = fixture({
    prepareToInstall: () =>
      new Promise((resolve) => {
        resolveCleanup = resolve
      })
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  const first = f.controller.restart()
  const second = f.controller.restart()
  resolveCleanup()
  await Promise.all([first, second])
  await f.controller.restart()
  assert.equal(f.calls.installs, 1)
  assert.equal(f.controller.state.kind, 'installing')
})

test('install failure event restores ready version for a later retry', async () => {
  const f = fixture()
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  await f.controller.restart()
  f.listeners.get('error')(new Error('signature'))
  assert.equal(f.controller.state.kind, 'ready')
  assert.equal(f.controller.state.version, '0.2.0')
  assert.equal(f.calls.dialogs.at(-1).kind, 'failed')
})

test('synchronous install failure retains the ready version for retry', async () => {
  let attempts = 0
  const f = fixture({
    quitAndInstall: () => {
      attempts += 1
      throw new Error('native')
    }
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  await f.controller.restart()
  assert.equal(f.controller.state.kind, 'ready')
  assert.equal(f.controller.state.version, '0.2.0')
  assert.equal(attempts, 1)
  assert.equal(f.calls.installs, 1)
})

test('a rejected ready dialog does not create an unhandled rejection', async () => {
  const f = fixture({
    present: async (notice) => {
      if (notice.kind === 'ready') throw new Error('dialog failed')
      return 'later'
    }
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.controller.state.kind, 'ready')
})

test('dispose during cleanup fences the eventual install', async () => {
  let resolveCleanup
  const f = fixture({
    prepareToInstall: () =>
      new Promise((resolve) => {
        resolveCleanup = resolve
      })
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  await pending
  const restarting = f.controller.restart()
  f.controller.dispose()
  resolveCleanup()
  await restarting
  assert.equal(f.calls.installs, 0)
})

test('startup and recurring checks rearm one timer and dispose fences pending work', async () => {
  const f = fixture({ deferred: true })
  assert.equal(f.timers[0].delay, 30_000)
  f.timers[0].callback()
  f.resolveCheck()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.timers.length, 2)
  assert.equal(f.timers[1].delay, 24 * 60 * 60 * 1000)
  f.timers[1].callback()
  f.resolveCheck()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(f.timers.length, 3)
  assert.equal(f.timers[2].delay, 24 * 60 * 60 * 1000)
  const lateDownload = f.listeners.get('update-downloaded')
  const statesBeforeLateEvent = f.calls.states.length
  f.controller.dispose()
  assert.equal(f.timers[2].cleared, true)
  assert.equal(f.calls.removed.length, 4)
  lateDownload({ version: '0.3.0' })
  assert.notEqual(f.controller.state.kind, 'ready')
  assert.equal(f.calls.states.length, statesBeforeLateEvent)
  assert.equal(f.calls.dialogs.length, 0)
  await f.controller.check(true)
  assert.equal(f.calls.checks, 2)
})

test('disposed ready dialog decision cannot install', async () => {
  let choose
  const f = fixture({
    deferred: true,
    present: (notice) =>
      new Promise((resolve) => {
        if (notice.kind === 'ready') choose = resolve
        else resolve('later')
      })
  })
  const pending = f.controller.check(false)
  f.listeners.get('update-available')({ version: '0.2.0' })
  f.listeners.get('update-downloaded')({ version: '0.2.0' })
  const statesAtDispose = f.calls.states.length
  const dialogsAtDispose = f.calls.dialogs.length
  f.controller.dispose()
  choose('restart')
  f.resolveCheck()
  await pending
  await Promise.resolve()
  assert.equal(f.calls.installs, 0)
  assert.equal(f.calls.states.length, statesAtDispose)
  assert.equal(f.calls.dialogs.length, dialogsAtDispose)
})
