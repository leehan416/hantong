import assert from 'node:assert/strict'
import test from 'node:test'
import { ALLOWED_API_OPERATIONS, assertAllowedApiOperations } from './helpers/api-contract.mjs'
import { loadTypeScript } from './helpers/load-typescript.mjs'

test('actual preload exposes exactly the allowed API operations offline', () => {
  let exposedApi
  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        assert.equal(name, 'api')
        exposedApi = api
      }
    },
    ipcRenderer: {
      invoke: () => Promise.resolve(undefined),
      on: () => undefined,
      removeListener: () => undefined
    }
  }

  loadTypeScript(new URL('../src/preload/index.ts', import.meta.url), {
    electron,
    process: { contextIsolated: true, isMainFrame: true }
  })

  assert.ok(exposedApi)
  assertAllowedApiOperations(Object.keys(exposedApi))
})

test('API contract comparison ignores property order but rejects additions and removals', () => {
  assert.doesNotThrow(() => assertAllowedApiOperations([...ALLOWED_API_OPERATIONS].reverse()))
  assert.throws(() => assertAllowedApiOperations(ALLOWED_API_OPERATIONS.slice(1)))
  assert.throws(() => assertAllowedApiOperations([...ALLOWED_API_OPERATIONS, 'sendAnyChannel']))
})
