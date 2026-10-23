import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createLoginLaunchStartupController } = loadTypeScript(
  new URL('../src/main/login-launch-startup.ts', import.meta.url)
)

test('early reveal wins over hidden login startup and later reveal opens the window', () => {
  const actions = []
  const hidden = createLoginLaunchStartupController({
    showWindow: () => actions.push('show'),
    hideDock: () => actions.push('hide')
  })
  hidden.requestReveal()
  hidden.start(true)
  assert.deepEqual(actions, ['show'])
  const automatic = createLoginLaunchStartupController({
    showWindow: () => actions.push('show'),
    hideDock: () => actions.push('hide')
  })
  automatic.start(true)
  automatic.requestReveal()
  assert.deepEqual(actions, ['show', 'hide', 'show'])
  const manual = createLoginLaunchStartupController({
    showWindow: () => actions.push('show'),
    hideDock: () => actions.push('hide')
  })
  manual.start(false)
  assert.deepEqual(actions, ['show', 'hide', 'show', 'show'])
})
