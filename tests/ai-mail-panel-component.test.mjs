/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test harness uses plain JavaScript hooks and component props. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'
const { aiMailFieldFeedback } = loadTypeScript(
  new URL('../src/renderer/src/ai-mail-panel-flow.ts', import.meta.url)
)

function createHooks() {
  const slots = []
  const effects = []
  let index = 0
  const sameDeps = (a, b) =>
    a && b && a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
  const hooks = {
    beginRender() {
      index = 0
      effects.length = 0
    },
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
      if (!slots[slot]) slots[slot] = { value: { current: initial } }
      return slots[slot].value
    },
    useMemo(factory, deps) {
      const slot = index++
      if (!slots[slot] || !sameDeps(slots[slot].deps, deps))
        slots[slot] = { value: factory(), deps }
      return slots[slot].value
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps)
    },
    useEffect(callback, deps) {
      const slot = index++
      const previous = slots[slot]
      if (!previous || !sameDeps(previous.deps, deps))
        effects.push(() => {
          previous?.cleanup?.()
          const cleanup = callback()
          slots[slot] = { deps, cleanup }
        })
    },
    flushEffects() {
      for (const run of effects.splice(0)) run()
    }
  }
  return hooks
}

function findElement(node, predicate) {
  if (Array.isArray(node))
    for (const child of node) {
      const result = findElement(child, predicate)
      if (result) return result
    }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const values = node.props ? Object.values(node.props) : []
  for (const value of values) {
    for (const child of Array.isArray(value) ? value : [value]) {
      const result = findElement(child, predicate)
      if (result) return result
    }
  }
  return null
}

const target = { status: 'none' }
const read = {
  status: 'ready',
  accountId: 'account-a',
  accountLabel: 'A',
  captureId: 'read-1',
  subject: 'Received subject',
  body: 'Received body'
}

function setup(api, timers = []) {
  const hooks = createHooks()
  const { AiMailPanel } = loadTypeScript(
    new URL('../src/renderer/src/AiMailPanel.tsx', import.meta.url),
    {
      react: hooks,
      window: { api },
      './AiMailChatLayout': {
        AiMailChatLayout: (props) => ({
          type: 'chat-layout',
          props: { children: [props.header, props.context, props.children, props.composer] }
        })
      },
      setTimeout: (callback, delay) => {
        const timer = { callback, delay }
        timers.push(timer)
        return timer
      },
      clearTimeout: (timer) => {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      }
    }
  )
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/app-messages.ts', import.meta.url)
  )
  let props = {
    activeAccountId: 'account-a',
    layoutMode: 'right',
    open: false,
    captureSession: 0,
    text: messages.en.aiMail,
    onClose: () => undefined
  }
  const render = () => {
    hooks.beginRender()
    const tree = AiMailPanel(props)
    hooks.flushEffects()
    return tree
  }
  return {
    render,
    setProps: (next) => {
      props = { ...props, ...next }
    },
    messages
  }
}

test('opening automatically captures received mail without a compose and displays an inspectable chip', async () => {
  let reads = 0
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'unavailable', cloudDisabled: false }),
    getOllamaModels: async () => [],
    getCodexModels: async () => ({ state: 'unavailable', reason: 'not_connected' }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => {
      reads += 1
      return read
    },
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api)
  app.render()
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  const tree = app.render()
  assert.equal(reads, 1)
  assert.ok(
    findElement(
      tree,
      (node) => node.type === 'summary' && node.props.className === 'ai-mail-context-chip'
    )
  )
  assert.ok(findElement(tree, (node) => node.type === 'pre' && node.props.children === read.body))
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'Test response'),
    null
  )
  assert.equal(
    findElement(
      tree,
      (node) =>
        node.type === 'button' && node.props.children === 'Capture opened email subject and body'
    ),
    null
  )
})

test('unsupported generation is stated honestly and the composer remains disabled', async () => {
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'connected' }),
    getOllamaStatus: async () => ({ state: 'unavailable', cloudDisabled: false }),
    getOllamaModels: async () => [],
    getCodexModels: async () => ({
      state: 'available',
      models: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture' }]
    }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => read,
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api)
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  const tree = app.render()
  const composer = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.ok(composer)
  assert.equal(composer.props.disabled, true)
  assert.ok(
    findElement(
      tree,
      (node) =>
        node.type === 'p' &&
        node.props.children === app.messages.en.aiMail.codexGenerationUnavailable
    )
  )
})

test('provider and model selectors use independent catalogs and preserve a missing saved choice', async () => {
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    getCodexModels: async () => ({
      state: 'available',
      models: [{ id: 'gpt-one', model: 'gpt-one', displayName: 'GPT One' }]
    }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => read,
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api)
  app.setProps({
    open: true,
    settings: {
      version: 1,
      language: 'en',
      theme: 'system',
      closeAction: 'hide',
      hideGmailLogo: false,
      hideHeaderButtons: false,
      hideSidePanel: false,
      hideStoragePromo: false,
      accountSelectorPosition: 'top',
      sidebarCollapsed: false,
      aiMailProvider: 'ollama',
      ollamaModel: 'qwen3:8b',
      codexModel: 'gpt-one'
    },
    onChangeSettings: async () => true
  })
  app.render()
  await new Promise(setImmediate)
  const tree = app.render()
  const composer = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.equal(composer.props.disabled, false)
  const select = findElement(
    tree,
    (node) => node.type === 'select' && node.props.id === 'ai-mail-model'
  )
  assert.equal(select.props.value, 'qwen3:8b')
  assert.ok(findElement(tree, (node) => node.type === 'option' && node.props.value === 'qwen3:8b'))
  assert.equal(
    findElement(tree, (node) => node.type === 'option' && node.props.value === 'gpt-one'),
    null
  )
})

test('account A-B-A invalidation clears pending UI and fences the cancelled response from a newer turn', async () => {
  let activeAccount = 'account-a'
  let generationCalls = 0
  const pendingResolvers = []
  const currentRead = () => ({
    ...read,
    accountId: activeAccount,
    captureId: `read-${activeAccount}`
  })
  const listeners = []
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: (listener) => {
      listeners.push(listener)
      return () => undefined
    },
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    getCodexModels: async () => ({ state: 'unavailable', reason: 'not_connected' }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => currentRead(),
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' }),
    generateAiMailWithOllama: () => {
      generationCalls += 1
      return new Promise((resolve) => pendingResolvers.push(resolve))
    }
  }
  const app = setup(api)
  app.setProps({
    open: true,
    settings: {
      version: 1,
      language: 'en',
      theme: 'system',
      closeAction: 'hide',
      hideGmailLogo: false,
      hideHeaderButtons: false,
      hideSidePanel: false,
      hideStoragePromo: false,
      accountSelectorPosition: 'top',
      sidebarCollapsed: false,
      aiMailProvider: 'ollama',
      ollamaModel: 'qwen3:8b',
      codexModel: null
    },
    onChangeSettings: async () => true
  })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  let textarea = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  textarea.props.onChange({ target: { value: 'Summarize this email' } })
  tree = app.render()
  let form = findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  )
  form.props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  assert.equal(generationCalls, 1)
  assert.ok(findElement(app.render(), (node) => node.props?.className === 'ai-mail-pending'))

  activeAccount = 'account-b'
  app.setProps({ activeAccountId: activeAccount })
  app.render()
  await new Promise(setImmediate)
  activeAccount = 'account-a'
  app.setProps({ activeAccountId: activeAccount })
  for (let index = 0; index < 4; index += 1) {
    await new Promise(setImmediate)
    tree = app.render()
  }
  assert.equal(
    findElement(tree, (node) => node.props?.className === 'ai-mail-pending'),
    null
  )

  textarea = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.equal(textarea.props.disabled, false, 'A-B-A context must permit another request')
  textarea.props.onChange({ target: { value: 'A new request' } })
  tree = app.render()
  form = findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  )
  form.props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  assert.equal(generationCalls, 2)

  pendingResolvers[0]({ ok: true, output: { kind: 'answer', text: 'Old response' } })
  await new Promise(setImmediate)
  assert.ok(findElement(app.render(), (node) => node.props?.className === 'ai-mail-pending'))
  pendingResolvers[1]({ ok: true, output: { kind: 'answer', text: 'New response' } })
})

test('retry keeps send disabled until the fresh Ollama inventory completes', async () => {
  let statusCalls = 0
  let finishRefresh
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => {
      statusCalls += 1
      if (statusCalls === 1) throw new Error('fixture unavailable')
      return new Promise((resolve) => {
        finishRefresh = () => resolve({ state: 'available', cloudDisabled: true })
      })
    },
    getOllamaModels: async () => {
      return [{ name: 'qwen3:8b', size: 10 }]
    },
    getCodexModels: async () => ({ state: 'unavailable', reason: 'not_connected' }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => read,
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api)
  app.setProps({
    open: true,
    settings: {
      version: 1,
      language: 'en',
      theme: 'system',
      closeAction: 'hide',
      hideGmailLogo: false,
      hideHeaderButtons: false,
      hideSidePanel: false,
      hideStoragePromo: false,
      accountSelectorPosition: 'top',
      sidebarCollapsed: false,
      aiMailProvider: 'ollama',
      ollamaModel: 'qwen3:8b',
      codexModel: null
    },
    onChangeSettings: async () => true
  })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  let textarea = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.equal(textarea.props.disabled, true)
  findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Try again'
  ).props.onClick()
  tree = app.render()
  textarea = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.equal(textarea.props.disabled, true)
  finishRefresh()
  await new Promise(setImmediate)
  tree = app.render()
  textarea = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.equal(textarea.props.disabled, false)
})

test('Codex catalog refreshes when connection becomes available', async () => {
  let catalogCalls = 0
  let codexStatusListener
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: (listener) => {
      codexStatusListener = listener
      return () => undefined
    },
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'unavailable', cloudDisabled: false }),
    getOllamaModels: async () => [],
    getCodexModels: async () => {
      catalogCalls += 1
      return catalogCalls === 1
        ? { state: 'unavailable', reason: 'not_connected' }
        : {
            state: 'available',
            models: [{ id: 'gpt-two', model: 'gpt-two', displayName: 'GPT Two' }]
          }
    },
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api)
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  assert.equal(catalogCalls, 1)
  codexStatusListener({ state: 'connected' })
  app.render()
  await new Promise(setImmediate)
  const tree = app.render()
  assert.equal(catalogCalls, 2)
  assert.ok(
    findElement(tree, (node) => node.type === 'option' && node.props.children === 'GPT Two')
  )
})

test('field mutation failures map to localized error and notice copy', () => {
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/app-messages.ts', import.meta.url)
  )
  const copy = messages.en.aiMail
  assert.equal(aiMailFieldFeedback('error', 'apply', copy), copy.applyError)
  assert.equal(aiMailFieldFeedback('error', 'undo', copy), copy.undoError)
  assert.equal(aiMailFieldFeedback('unsupported', 'apply', copy), copy.unsupportedTarget)
  assert.equal(aiMailFieldFeedback('stale', 'apply', copy), copy.staleMutation)
  assert.equal(aiMailFieldFeedback('busy', 'apply', copy), copy.busy)
})

test('read navigation after an empty open capture is detected with a coalesced timer', async () => {
  let currentRead = { status: 'none' }
  const timers = []
  let reads = 0
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'unavailable', cloudDisabled: false }),
    getOllamaModels: async () => [],
    getCodexModels: async () => ({ state: 'unavailable', reason: 'not_connected' }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => {
      reads += 1
      return currentRead
    },
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  const app = setup(api, timers)
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  assert.equal(reads, 1)
  const readPoll = timers.find((timer) => timer.delay === 5000)
  assert.ok(readPoll)
  currentRead = read
  readPoll.callback()
  await new Promise(setImmediate)
  const tree = app.render()
  assert.equal(reads, 2)
  assert.ok(findElement(tree, (node) => node.type === 'pre' && node.props.children === read.body))
})
