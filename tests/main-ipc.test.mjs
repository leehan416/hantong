/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const handlers = new Map()
const { registerMainIpc } = loadTypeScript(new URL('../src/main/main-ipc.ts', import.meta.url), {
  electron: {
    app: { getName: () => 'Hantong', getVersion: () => '1.0', getLocale: () => 'en-US' },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    nativeTheme: {},
    webContents: { getAllWebContents: () => [] }
  }
})
const accountId = '550e8400-e29b-41d4-a716-446655440000'

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function fixture(overrides = {}) {
  handlers.clear()
  const owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  const account = { id: accountId }
  const dependencies = {
    rendererUrl: 'file:///app/index.html',
    window: () => owner,
    views: () => null,
    access: () => null,
    notifications: () => null,
    settings: () => null,
    isQuitting: () => false,
    requireAccountStore: () => ({
      getState: () => ({ accounts: [account], activeAccountId: accountId })
    }),
    requireAccountRemoval: () => ({
      isBusy: () => false,
      assertIdle: () => undefined,
      remove: async () => ({ outcome: 'cancelled' })
    }),
    requireGoogleRuntime: () => ({
      getStatus: async () => ({ accountId, status: 'connected' })
    }),
    recovery: {
      clearPending: () => undefined,
      request: async () => undefined,
      hasPending: () => false
    },
    gmailCleanup: { apply: () => undefined },
    unreadCounts: () => ({ unreadCounts: () => new Map() }),
    locale: () => 'en',
    activateView: () => undefined,
    publishAccountState: () => undefined,
    installAppMenu: () => undefined,
    createWindow: () => undefined,
    loginLaunch: {
      getState: async () => ({ supported: true, enabled: false, status: 'disabled' }),
      setEnabled: async (enabled) => ({
        supported: true,
        enabled,
        status: enabled ? 'enabled' : 'disabled'
      })
    },
    aiMailCodex: {
      getStatus: () => ({ state: 'connected' }),
      getModels: async () => ({
        state: 'available',
        models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' }]
      }),
      connect: async () => ({ state: 'connected' }),
      disconnect: async () => ({ state: 'disconnected' }),
      generate: async () => ({ ok: false, error: 'unsupported', reason: 'not_ready' }),
      cancel: async () => ({ cancelled: false }),
      dispose: async () => undefined
    },
    ollama: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => [{ name: 'qwen3:8b', size: 100 }],
      validateModel: async () => undefined,
      dispose: () => undefined
    },
    aiModel: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => ['qwen3:8b'],
      generate: async () => ({ kind: 'answer', text: 'ready' }),
      dispose: async () => undefined
    },
    ollamaCredentials: {
      has: async () => false,
      get: async () => null,
      set: async () => undefined,
      clear: async () => undefined
    },
    ...overrides
  }
  registerMainIpc(dependencies)
  return { owner, account }
}

function invokeEvent(owner, sender = owner.webContents) {
  const frame = { url: 'file:///app/index.html' }
  sender.mainFrame = frame
  return { sender, senderFrame: frame }
}

test('provider model IPC is owner-frame only and Codex returns the live catalog contract', async () => {
  const { owner } = fixture()
  const event = invokeEvent(owner)
  const status = handlers.get('hantong:ollama-status')
  const models = handlers.get('hantong:ollama-models')
  const codexModels = handlers.get('hantong:codex-models')
  assert.deepEqual(JSON.parse(JSON.stringify(await status(event))), {
    state: 'available',
    cloudDisabled: true
  })
  assert.deepEqual(JSON.parse(JSON.stringify(await models(event))), [
    { name: 'qwen3:8b', size: null }
  ])
  assert.deepEqual(JSON.parse(JSON.stringify(await codexModels(event))), {
    state: 'available',
    models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' }]
  })
  await assert.rejects(status(event, 'http://127.0.0.1'), /Request rejected/)
  await assert.rejects(models(invokeEvent(owner, {})), /Request rejected/)
})

test('clipboard IPC writes bounded text only from the owner frame', () => {
  const writes = []
  const { owner } = fixture({ writeClipboardText: (value) => writes.push(value) })
  const copy = handlers.get('hantong:clipboard-write-text')
  const event = invokeEvent(owner)

  copy(event, 'revision text')
  assert.deepEqual(writes, ['revision text'])
  assert.throws(() => copy(event, 'x'.repeat(140_000)), /Request rejected/)
  assert.throws(() => copy(invokeEvent(owner, {}), 'untrusted'), /Request rejected/)
  assert.throws(() => copy(event, { text: 'not a string' }), /Request rejected/)
})

test('compose target selection uses owner-frame IPC and returns a freshly checked snapshot', async () => {
  let selectedRequest
  const snapshot = {
    status: 'ready',
    accountId,
    composeId: 'opaque-compose-id',
    accountLabel: 'Account',
    documentVersion: 'document-version',
    snapshotId: 'snapshot-id',
    subject: 'Current subject',
    recipients: [],
    body: 'Current body',
    candidates: [{ composeId: 'opaque-compose-id', label: 'Current subject', lastUsedAt: 10 }]
  }
  const { owner } = fixture({
    composeTarget: () => ({
      selectTarget: async (request) => {
        selectedRequest = request
        return snapshot
      },
      isResultCurrent: () => true,
      isResultTargetCurrent: async () => true
    })
  })
  const select = handlers.get('hantong:ai-mail-compose-select-target')
  const event = invokeEvent(owner)
  assert.deepEqual(
    JSON.parse(JSON.stringify(await select(event, { accountId, composeId: 'opaque-compose-id' }))),
    snapshot
  )
  assert.deepEqual(selectedRequest, { accountId, composeId: 'opaque-compose-id' })
  await assert.rejects(
    select(invokeEvent(owner, {}), { accountId, composeId: 'opaque-compose-id' }),
    /Request rejected/
  )
})

test('settings IPC validates local Ollama model selection before persistence', async () => {
  const updates = []
  let modelChecks = 0
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'codex',
    ollamaModel: null,
    codexModel: null
  }
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      updates.push(patch)
      Object.assign(saved, patch)
      return { ...saved, ...patch }
    }
  }
  const { owner } = fixture({
    settings: () => settingsStore,
    ollama: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => [],
      validateModel: async (name) => {
        modelChecks++
        if (name !== 'qwen3:8b') throw new Error('Ollama model is not available as a local model')
      },
      dispose: () => undefined
    }
  })
  const update = handlers.get('hantong:settings-update')
  const event = invokeEvent(owner)
  await assert.rejects(
    update(event, { aiMailProvider: 'ollama' }),
    /Select an available Ollama model first/
  )
  await assert.rejects(
    update(event, { ollamaModel: 'remote:latest' }),
    /not available as a local model/
  )
  assert.deepEqual(updates, [])
  await update(event, { ollamaModel: 'qwen3:8b' })
  await update(event, { aiMailProvider: 'ollama' })
  await assert.rejects(
    update(event, { ollamaModel: null }),
    /Select an available Ollama model first/
  )
  assert.equal(modelChecks, 3)
  assert.deepEqual(updates, [{ ollamaModel: 'qwen3:8b' }, { aiMailProvider: 'ollama' }])
})

test('concurrent settings updates validate against the latest persisted provider and model', async () => {
  const validation = deferred()
  const validationStarted = deferred()
  const updates = []
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'codex',
    ollamaModel: 'qwen3:8b',
    codexModel: null
  }
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      updates.push(patch)
      Object.assign(saved, patch)
      return { ...saved }
    }
  }
  const { owner } = fixture({
    settings: () => settingsStore,
    ollama: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => [],
      validateModel: async () => {
        validationStarted.resolve()
        await validation.promise
      },
      dispose: () => undefined
    }
  })
  const update = handlers.get('hantong:settings-update')
  const event = invokeEvent(owner)
  const switchProvider = update(event, { aiMailProvider: 'ollama' })
  await validationStarted.promise
  const clearModel = update(event, { ollamaModel: null })
  validation.resolve()

  await switchProvider
  await assert.rejects(clearModel, /Select an available Ollama model first/)
  assert.deepEqual(saved, {
    version: 1,
    theme: 'system',
    aiMailProvider: 'ollama',
    ollamaModel: 'qwen3:8b',
    codexModel: null
  })
  assert.deepEqual(updates, [{ aiMailProvider: 'ollama' }])
})

test('settings update rejects when its owner window is replaced during model validation', async () => {
  const validation = deferred()
  const validationStarted = deferred()
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'codex',
    ollamaModel: null,
    codexModel: null
  }
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      Object.assign(saved, patch)
      return { ...saved }
    }
  }
  let owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  fixture({
    window: () => owner,
    settings: () => settingsStore,
    ollama: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => [],
      validateModel: async () => {
        validationStarted.resolve()
        await validation.promise
      },
      dispose: () => undefined
    }
  })
  const update = handlers.get('hantong:settings-update')
  const event = invokeEvent(owner)
  const pending = update(event, { ollamaModel: 'qwen3:8b' })
  await validationStarted.promise
  owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  validation.resolve()

  await assert.rejects(pending, /Request rejected/)
  assert.equal(saved.ollamaModel, null)
})

test('settings update rejects when its owner frame navigates during model validation', async () => {
  const validation = deferred()
  const validationStarted = deferred()
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'codex',
    ollamaModel: null,
    codexModel: null
  }
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      Object.assign(saved, patch)
      return { ...saved }
    }
  }
  const { owner } = fixture({
    settings: () => settingsStore,
    ollama: {
      getStatus: async () => ({ state: 'available', cloudDisabled: true }),
      getModels: async () => [],
      validateModel: async () => {
        validationStarted.resolve()
        await validation.promise
      },
      dispose: () => undefined
    }
  })
  const update = handlers.get('hantong:settings-update')
  const event = invokeEvent(owner)
  const pending = update(event, { ollamaModel: 'qwen3:8b' })
  await validationStarted.promise
  event.senderFrame.url = 'file:///untrusted/index.html'
  validation.resolve()

  await assert.rejects(pending, /Request rejected/)
  assert.equal(saved.ollamaModel, null)
})

test('non-provider settings remain editable when selected Ollama is offline', async () => {
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'ollama',
    ollamaModel: 'qwen3:8b',
    codexModel: null
  }
  let updates = 0
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      updates++
      Object.assign(saved, patch)
      return { ...saved }
    }
  }
  const { owner } = fixture({
    settings: () => settingsStore,
    ollama: {
      getStatus: async () => ({ state: 'unavailable', cloudDisabled: false }),
      getModels: async () => [],
      validateModel: async () => {
        throw new Error('Ollama is offline')
      },
      dispose: () => undefined
    }
  })

  const result = await handlers.get('hantong:settings-update')(invokeEvent(owner), {
    theme: 'dark'
  })

  assert.equal(result.theme, 'dark')
  assert.equal(result.aiMailProvider, 'ollama')
  assert.equal(updates, 1)
})

test('Codex model settings accept only entries from the connected app-server catalog', async () => {
  const updates = []
  const saved = {
    version: 1,
    theme: 'system',
    aiMailProvider: 'codex',
    ollamaModel: null,
    codexModel: null
  }
  const settingsStore = {
    get: () => ({ ...saved }),
    update: (patch) => {
      updates.push(patch)
      Object.assign(saved, patch)
      return { ...saved }
    }
  }
  const { owner } = fixture({
    settings: () => settingsStore,
    aiMailCodex: {
      getStatus: () => ({ state: 'connected' }),
      getModels: async () => ({
        state: 'available',
        models: [{ id: 'gpt-6.1-sol', model: 'gpt-6.1-sol', displayName: 'GPT 6.1 Sol' }]
      })
    }
  })
  const update = handlers.get('hantong:settings-update')
  const event = invokeEvent(owner)
  await assert.rejects(
    update(event, { codexModel: 'invented-model' }),
    /Select an available Codex model first/
  )
  await update(event, { codexModel: 'gpt-6.1-sol' })
  assert.deepEqual(updates, [{ codexModel: 'gpt-6.1-sol' }])
})

test('trusted URL from a foreign sender is rejected by IPC ownership checks', () => {
  const { owner } = fixture()
  const handler = handlers.get('hantong:app-info')
  assert.throws(() => handler(invokeEvent(owner, {})), /Request rejected/)
})

test('login launch IPC validates sender and exact arguments before calling its controller', async () => {
  let gets = 0
  const writes = []
  const { owner } = fixture({
    loginLaunch: {
      getState: async () => {
        gets++
        return { supported: true, enabled: false, status: 'disabled' }
      },
      setEnabled: async (enabled) => {
        writes.push(enabled)
        return { supported: true, enabled, status: enabled ? 'enabled' : 'disabled' }
      }
    }
  })
  const get = handlers.get('hantong:login-launch-get')
  const set = handlers.get('hantong:login-launch-set')
  const event = invokeEvent(owner)
  assert.deepEqual(await get(event), {
    supported: true,
    enabled: false,
    status: 'disabled'
  })
  await assert.rejects(get(event, false), /Request rejected/)
  await assert.rejects(set(event), /Request rejected/)
  await assert.rejects(set(event, 'true'), /Request rejected/)
  await assert.rejects(set(event, true, false), /Request rejected/)
  const foreignFrame = { sender: event.sender, senderFrame: { url: event.senderFrame.url } }
  await assert.rejects(set(foreignFrame, true), /Request rejected/)
  await assert.rejects(get(invokeEvent(owner, {})), /Request rejected/)
  assert.equal(gets, 1)
  assert.deepEqual(writes, [])
  // Invalid senders and arguments never reach the Main controller that owns the native prompt.
  await set(event, true)
  await set(event, false)
  assert.deepEqual(writes, [true, false])
})

test('AI mail panel layout IPC accepts only the owner frame and an exact boolean', () => {
  const changes = []
  const { owner } = fixture({
    views: () => ({ setAiMailPanelOpen: (open) => changes.push(open) })
  })
  const handler = handlers.get('hantong:ai-mail-panel-layout')
  const event = invokeEvent(owner)
  assert.throws(() => handler(event), /Request rejected/)
  assert.throws(() => handler(event, 'true'), /Request rejected/)
  assert.throws(() => handler(event, true, false), /Request rejected/)
  assert.throws(() => handler(invokeEvent(owner, {}), true), /Request rejected/)
  assert.deepEqual(changes, [])
  handler(event, true)
  handler(event, false)
  assert.deepEqual(changes, [true, false])
})

test('notification preference IPC validates exact arguments and persists through account store', () => {
  let persisted = false
  let published = null
  const { owner } = fixture({
    requireAccountStore: () => ({
      getState: () => ({ accounts: [{ id: accountId }], activeAccountId: accountId }),
      setNotificationsEnabled: (id, enabled) => {
        assert.equal(id, accountId)
        assert.equal(enabled, false)
        persisted = true
        return {
          version: 1,
          accounts: [{ id, notificationsEnabled: enabled }],
          activeAccountId: id
        }
      }
    }),
    publishAccountState: (_owner, state) => (published = state)
  })
  const handler = handlers.get('hantong:accounts-notifications-enabled')
  const event = invokeEvent(owner)
  assert.throws(() => handler(event, accountId), /Request rejected/)
  assert.throws(() => handler(event, accountId, 'false'), /Request rejected/)
  assert.throws(() => handler(event, accountId, false, 'extra'), /Request rejected/)
  assert.equal(persisted, false)
  const state = handler(event, accountId, false)
  assert.equal(persisted, true)
  assert.deepEqual(published, state)
})

test('Google status completion is rejected after its owning window changes', async () => {
  const pending = deferred()
  const firstWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  const secondWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  let currentWindow = firstWindow
  let calls = 0
  fixture({
    window: () => currentWindow,
    requireGoogleRuntime: () => ({
      getStatus: () => {
        calls += 1
        return pending.promise
      }
    })
  })
  const event = invokeEvent(firstWindow)
  const operation = handlers.get('hantong:google-connection-status')(event, accountId)
  assert.equal(calls, 1)
  currentWindow = secondWindow
  pending.resolve({ accountId, status: 'connected' })
  await assert.rejects(operation, /Request rejected/)
})

test('compose apply IPC validates payloads and rechecks the owner after awaiting Main', async () => {
  const pending = deferred()
  const firstWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  const secondWindow = { webContents: { send: () => undefined }, isDestroyed: () => false }
  let currentWindow = firstWindow
  let calls = 0
  fixture({
    window: () => currentWindow,
    composeTarget: () => ({
      applyDraft: (request) => {
        calls += 1
        assert.equal(request.replacement, 'Synthetic replacement')
        return pending.promise
      }
    })
  })
  const apply = handlers.get('hantong:ai-mail-compose-apply')
  const event = invokeEvent(firstWindow)
  await assert.rejects(apply(event, { accountId: '../wrong' }), /Request rejected/)
  assert.equal(calls, 0)
  const operation = apply(event, {
    accountId: 'account-a',
    composeId: 'compose-a',
    documentVersion: 'document-a',
    snapshotId: 'snapshot-a',
    replacement: 'Synthetic replacement'
  })
  assert.equal(calls, 1)
  currentWindow = secondWindow
  pending.resolve({ status: 'applied', applyId: 'apply-a' })
  await assert.rejects(operation, /Request rejected/)
})

test('Google status completion returns when its original owner remains current', async () => {
  const pending = deferred()
  const owner = { webContents: { send: () => undefined }, isDestroyed: () => false }
  fixture({
    window: () => owner,
    requireGoogleRuntime: () => ({ getStatus: () => pending.promise })
  })
  const operation = handlers.get('hantong:google-connection-status')(invokeEvent(owner), accountId)
  const status = { accountId, status: 'connected' }
  pending.resolve(status)
  assert.deepEqual(await operation, status)
})
