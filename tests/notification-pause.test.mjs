/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { buildAppMenuTemplate, buildTrayMenuTemplate } = loadTypeScript(
  new URL('../src/main/app-menu.ts', import.meta.url)
)
const { createNotificationPauseController, createNotificationPauseMenuActions, nextLocalMidnight } =
  loadTypeScript(new URL('../src/main/notification-pause.ts', import.meta.url))
const BASE = 1_800_000_000_000

function fixture({
  state = { version: 1, pausedUntil: null, notifyAfter: 0 },
  startNow = BASE
} = {}) {
  let now = startNow
  let nextTimer = 0
  const timers = new Map()
  const saved = []
  const changes = []
  let current = { ...state }
  const store = {
    getState: () => ({ ...current }),
    setPause: (pausedUntil) => {
      current = { version: 1, pausedUntil, notifyAfter: pausedUntil }
      saved.push({ ...current })
      return { ...current }
    },
    resume: (notifyAfter) => {
      current = { version: 1, pausedUntil: null, notifyAfter }
      saved.push({ ...current })
      return { ...current }
    }
  }
  const controller = createNotificationPauseController({
    store,
    now: () => now,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
    onChange: (snapshot) => changes.push({ ...snapshot })
  })
  return {
    controller,
    timers,
    saved,
    changes,
    setNow: (value) => (now = value),
    fireTimer: (id = timers.keys().next().value) => {
      const timer = timers.get(id)
      timers.delete(id)
      timer?.callback()
    }
  }
}

test('pause choices persist fixed durations and resume now persists the current cutoff', () => {
  const { controller, saved, setNow } = fixture()
  controller.pauseFor('30m')
  assert.deepEqual(saved[0], {
    version: 1,
    pausedUntil: BASE + 30 * 60_000,
    notifyAfter: BASE + 30 * 60_000
  })
  controller.pauseFor('1h')
  assert.equal(saved[1].pausedUntil, BASE + 60 * 60_000)
  setNow(BASE + 1_000)
  controller.resumeNow()
  assert.deepEqual(saved[2], { version: 1, pausedUntil: null, notifyAfter: BASE + 1_000 })
  assert.throws(() => controller.pauseFor('2h'), /Invalid notification pause duration/)
  controller.dispose()
})

test('until tomorrow uses the next local midnight across daylight saving time', () => {
  const oldTimezone = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const now = Date.parse('2026-03-08T18:00:00.000Z')
    assert.equal(nextLocalMidnight(now), Date.parse('2026-03-09T07:00:00.000Z'))
    const { controller, saved } = fixture({ startNow: now })
    controller.pauseFor('tomorrow')
    assert.equal(saved[0].pausedUntil, Date.parse('2026-03-09T07:00:00.000Z'))
    controller.dispose()
  } finally {
    if (oldTimezone === undefined) delete process.env.TZ
    else process.env.TZ = oldTimezone
  }
})

test('restarted active and expired pauses retain cutoff and reevaluate expiry on timer wake', () => {
  const active = fixture({
    state: { version: 1, pausedUntil: BASE + 30_000, notifyAfter: BASE + 30_000 }
  })
  assert.equal(active.controller.snapshot().paused, true)
  const timer = [...active.timers.values()][0]
  assert.equal(timer.delay <= 60_000, true)
  active.setNow(BASE + 10_000)
  active.fireTimer()
  assert.equal(active.controller.snapshot().paused, true)
  assert.equal([...active.timers.values()][0].delay <= 60_000, true)
  active.setNow(BASE + 30_000)
  active.fireTimer()
  assert.equal(active.controller.snapshot().paused, false)
  assert.equal(active.controller.snapshot().notifyAfter, BASE + 30_000)
  assert.equal(active.timers.size, 0)
  active.controller.dispose()

  const expired = fixture({ state: { version: 1, pausedUntil: BASE - 1, notifyAfter: BASE - 1 } })
  assert.equal(expired.controller.snapshot().paused, false)
  assert.equal(expired.controller.snapshot().notifyAfter, BASE - 1)
  expired.controller.dispose()
})

test('clock jump and power resume reevaluate pause state and rebuild menu once', () => {
  const { controller, changes, setNow } = fixture({
    state: { version: 1, pausedUntil: BASE + 300_000, notifyAfter: BASE + 300_000 }
  })
  setNow(BASE + 400_000)
  controller.refresh()
  assert.equal(controller.snapshot().paused, false)
  assert.equal(changes.length, 1)
  controller.refresh()
  assert.equal(changes.length, 1)
  controller.dispose()
})

test('dispose clears the active expiry timer', () => {
  const { controller, timers } = fixture({
    state: { version: 1, pausedUntil: BASE + 300_000, notifyAfter: BASE + 300_000 }
  })
  assert.equal(timers.size, 1)
  controller.dispose()
  assert.equal(timers.size, 0)
})

test('failed persistence leaves revision, state, timer and menu failure signal unchanged', () => {
  let revision = 0
  const failures = []
  const timerRecords = new Map()
  let nextTimer = 0
  const state = { version: 1, pausedUntil: BASE + 20_000, notifyAfter: BASE + 20_000 }
  const controller = createNotificationPauseController({
    store: {
      getState: () => ({ ...state }),
      setPause: () => {
        throw new Error('private disk detail')
      },
      resume: () => {
        throw new Error('private disk detail')
      }
    },
    now: () => BASE,
    setTimeout: (callback, delay) => {
      const id = ++nextTimer
      timerRecords.set(id, { callback, delay })
      return id
    },
    clearTimeout: (id) => timerRecords.delete(id),
    onChange: () => (revision += 1)
  })
  const before = controller.snapshot()
  const beforeTimer = [...timerRecords.entries()]
  const actions = createNotificationPauseMenuActions(controller, (error) => failures.push(error))
  actions.pause30()
  assert.deepEqual(
    failures.map((error) => error.message),
    ['private disk detail']
  )
  assert.deepEqual(controller.snapshot(), before)
  assert.deepEqual([...timerRecords.entries()], beforeTimer)
  assert.equal(revision, 0)
  controller.dispose()
})

test('app and tray menus share localized pause choices, paused expiry, and resume action', () => {
  const calls = []
  const actions = {
    openSettings: () => undefined,
    notifications: {
      paused: false,
      pausedUntil: BASE + 30 * 60_000,
      pause30: () => calls.push('30m'),
      pause60: () => calls.push('1h'),
      pauseTomorrow: () => calls.push('tomorrow'),
      resume: () => calls.push('resume')
    }
  }
  const app = buildAppMenuTemplate('ko', actions)[0].submenu.find(
    (item) => item.label === '알림 잠시 끄기'
  )
  const tray = buildTrayMenuTemplate('ko', {
    open: () => undefined,
    quit: () => undefined,
    notifications: actions.notifications
  }).find((item) => item.label === '알림 잠시 끄기')
  assert.deepEqual(
    app.submenu.map((item) => item.label),
    tray.submenu.map((item) => item.label)
  )
  app.submenu[0].click()
  app.submenu[1].click()
  app.submenu[2].click()
  assert.deepEqual(calls, ['30m', '1h', 'tomorrow'])

  const paused = { ...actions, notifications: { ...actions.notifications, paused: true } }
  const pausedItem = buildTrayMenuTemplate('en', {
    open: () => undefined,
    quit: () => undefined,
    notifications: paused.notifications
  }).find((item) => item.label === 'Pause notifications')
  assert.equal(pausedItem.submenu[0].enabled, false)
  assert.equal(pausedItem.submenu[0].label.includes('Paused until'), true)
  pausedItem.submenu.at(-1).click()
  assert.deepEqual(calls, ['30m', '1h', 'tomorrow', 'resume'])
})

test('existing menu callers retain their original menu shape', () => {
  assert.equal(buildAppMenuTemplate('en', { openSettings: () => undefined }).length, 4)
  assert.equal(
    buildTrayMenuTemplate('en', { open: () => undefined, quit: () => undefined }).length,
    3
  )
})
