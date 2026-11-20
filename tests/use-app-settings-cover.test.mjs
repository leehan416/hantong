/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Hook harness uses plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

function loadSettingsHook(api) {
  const slots = []
  let index = 0
  const hooks = {
    useState(initial) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { value: initial }
      return [
        slots[slot].value,
        (next) => {
          slots[slot].value = typeof next === 'function' ? next(slots[slot].value) : next
        }
      ]
    },
    useRef(initial) {
      const slot = index++
      if (!slots[slot]) slots[slot] = { current: initial }
      return slots[slot]
    },
    useCallback(callback) {
      index += 1
      return callback
    },
    useEffect() {
      index += 1
    }
  }
  const { useAppSettings } = loadTypeScript(
    new URL('../src/renderer/src/use-app-settings.ts', import.meta.url),
    { react: hooks, window: { api } }
  )
  return () => {
    index = 0
    return useAppSettings()
  }
}

test('Settings and draft review share one native Gmail cover until the last dialog closes', async () => {
  const calls = []
  const snapshot = { accountId: 'account-a', dataUrl: 'data:image/png;base64,AA==', bounds: {} }
  const render = loadSettingsHook({
    setSettingsPanelOpen: async (open) => {
      calls.push(open)
      return open ? snapshot : null
    }
  })

  const first = render()
  const settingsSnapshot = first.acquireViewCover('settings')
  const reviewSnapshot = first.acquireViewCover('ai-mail-confirmation')
  assert.deepEqual(await Promise.all([settingsSnapshot, reviewSnapshot]), [snapshot, snapshot])
  assert.deepEqual(calls, [true])

  assert.equal(await first.releaseViewCover('settings'), true)
  assert.deepEqual(calls, [true])
  assert.equal(await first.releaseViewCover('ai-mail-confirmation'), true)
  assert.deepEqual(calls, [true, false])

  const current = render()
  assert.equal(current.settingsBackground, null)
})

test('failed native restore keeps the final cover owner available for retry', async () => {
  const calls = []
  let restoreAttempts = 0
  const render = loadSettingsHook({
    setSettingsPanelOpen: async (open) => {
      calls.push(open)
      if (!open && restoreAttempts++ < 2) throw new Error('temporary failure')
      return null
    }
  })
  const settings = render()
  await settings.acquireViewCover('ai-mail-confirmation')
  assert.equal(await settings.releaseViewCover('ai-mail-confirmation'), false)
  assert.deepEqual(calls, [true, false, false])
  assert.equal(await settings.releaseViewCover('ai-mail-confirmation'), true)
  assert.deepEqual(calls, [true, false, false, false])
})
