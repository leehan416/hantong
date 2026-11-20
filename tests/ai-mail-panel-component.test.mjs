/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test harness uses plain JavaScript hooks and component props. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { loadTypeScript } from './helpers/load-typescript.mjs'
const { aiMailFieldFeedback } = loadTypeScript(
  new URL(
    '../src/renderer/src/components/ai-mail/AiMailPanel/ai-mail-panel-flow.ts',
    import.meta.url
  )
)

test('data-sharing caption uses compact rules from the loaded panel stylesheet', async () => {
  const mainStylesheetUrl = new URL('../src/renderer/src/assets/main.css', import.meta.url)
  const mainStylesheet = await readFile(mainStylesheetUrl, 'utf8')
  assert.doesNotMatch(mainStylesheet, /ai-mail-panel\.css/)
  const panelComponent = await readFile(
    new URL('../src/renderer/src/components/ai-mail/AiMailPanel/AiMailPanel.tsx', import.meta.url),
    'utf8'
  )
  assert.match(panelComponent, /import ['"]\.\/ai-mail-panel\.css['"];?/)
  const panelStylesheet = await readFile(
    new URL(
      '../src/renderer/src/components/ai-mail/AiMailPanel/ai-mail-panel.css',
      import.meta.url
    ),
    'utf8'
  )
  assert.match(panelStylesheet, /\.ai-mail-data-sharing\s*\{[^}]*font-size:\s*11px/s)
  assert.match(panelStylesheet, /\.ai-mail-proposal textarea\s*\{[^}]*max-height:\s*none/s)
  assert.match(panelStylesheet, /\.ai-mail-proposal textarea\s*\{[^}]*overflow:\s*hidden/s)
  assert.doesNotMatch(panelStylesheet, /\.ai-mail-confirm-dialog\s*>\s*div/)
  assert.match(panelStylesheet, /\.ai-mail-apply-review\s*\{[^}]*flex-direction:\s*column/s)
  assert.match(panelStylesheet, /\.ai-mail-apply-review pre[^}]*white-space:\s*pre-wrap/s)
  const settingsStylesheet = await readFile(
    new URL('../src/renderer/src/assets/settings.css', import.meta.url),
    'utf8'
  )
  assert.match(settingsStylesheet, /\.app-dialog::backdrop/)
})

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

function findElements(node, predicate, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) findElements(child, predicate, result)
    return result
  }
  if (!node || typeof node !== 'object') return result
  if (predicate(node)) result.push(node)
  const values = node.props ? Object.values(node.props) : []
  for (const value of values) {
    for (const child of Array.isArray(value) ? value : [value])
      findElements(child, predicate, result)
  }
  return result
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
    new URL('../src/renderer/src/components/ai-mail/AiMailPanel/AiMailPanel.tsx', import.meta.url),
    {
      react: hooks,
      window: { api, addEventListener: () => undefined, removeEventListener: () => undefined },
      document: { activeElement: null, body: {}, querySelectorAll: () => [] },
      HTMLElement: class HTMLElement {},
      './ai-mail-panel.css': {},
      './AiMailChatLayout': {
        AiMailChatLayout: (props) => ({
          type: 'chat-layout',
          props: { children: [props.header, props.context, props.children, props.composer] }
        })
      },
      '~/renderer/src/components/settings/SettingsDialog/SettingsDialog': {
        AppDialog: (props) => ({
          type: 'dialog',
          props: { ...props, children: props.children }
        })
      },
      // Header icon buttons render as plain buttons so tests find them by aria-label.
      '~/renderer/src/components/common/IconActionButton/IconActionButton': {
        IconActionButton: 'button'
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
    new URL('../src/renderer/src/messages/app-messages.ts', import.meta.url)
  )
  let props = {
    activeAccountId: 'account-a',
    layoutMode: 'right',
    open: false,
    captureSession: 0,
    text: messages.en.aiMail,
    onConfirmationCover: async (open) => {
      const snapshot = await api.setSettingsPanelOpen?.(open)
      return snapshot ?? null
    },
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

test('unsupported generation is stated honestly while the composer stays editable', async () => {
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
  assert.notEqual(composer.props.disabled, true)
  composer.props.onChange({ target: { value: 'A message to send later' } })
  assert.equal(
    findElement(
      app.render(),
      (node) => node.type === 'button' && node.props['aria-label'] === 'Send'
    ).props.disabled,
    true
  )
  assert.ok(
    findElement(
      tree,
      (node) =>
        node.type === 'p' &&
        node.props.children === app.messages.en.aiMail.codexGenerationUnavailable
    )
  )
})

test('provider and model controls stay in settings while the panel keeps its composer', async () => {
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
  assert.notEqual(composer.props.disabled, true)
  assert.equal(
    findElement(tree, (node) => node.type === 'input' && node.props.name === 'ai-mail-provider'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'select' && node.props.id === 'ai-mail-model'),
    null
  )
})

test('opening the panel without a selected provider still leaves chat input available', async () => {
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
    settings: null,
    onChangeSettings: async () => true
  })
  app.render()
  await new Promise(setImmediate)
  const tree = app.render()
  assert.ok(findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label']))
  assert.equal(
    findElement(tree, (node) => node.type === 'input' && node.props.name === 'ai-mail-provider'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'select' && node.props.id === 'ai-mail-model'),
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
  let pendingTextarea = findElement(
    app.render(),
    (node) => node.type === 'textarea' && node.props['aria-label']
  )
  assert.notEqual(pendingTextarea.props.disabled, true)
  assert.equal(
    findElement(app.render(), (node) => node.type === 'span' && node.props.children === 'Thinking…')
      .props.children,
    'Thinking…'
  )
  pendingTextarea.props.onChange({ target: { value: 'One more question' } })
  assert.equal(
    findElement(app.render(), (node) => node.type === 'textarea' && node.props['aria-label']).props
      .value,
    'One more question'
  )

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
  assert.notEqual(textarea.props.disabled, true, 'A-B-A context must permit another request')
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

test('no open draft shows no hint, and an open draft shows as a chip before it is read', async () => {
  let status = { status: 'none' }
  const api = {
    getAiMailComposeTargetStatus: async () => status,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () => ({ status: 'none' })
  }
  let app = setup(api)
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const noTarget = app.messages.en.aiMail.noTarget
  assert.equal(JSON.stringify(tree).includes(noTarget), false)
  assert.equal(
    findElement(tree, (node) => node.props?.className === 'ai-mail-context-chip'),
    null
  )

  status = {
    status: 'none',
    candidates: [{ composeId: 'opaque-open-draft', label: 'Quarterly update', lastUsedAt: 0 }]
  }
  app = setup(api)
  app.setProps({ open: true })
  app.render()
  await new Promise(setImmediate)
  tree = app.render()
  const chip = findElement(
    tree,
    (node) => node.type === 'span' && node.props.className === 'ai-mail-context-chip'
  )
  assert.ok(chip)
  assert.ok(JSON.stringify(chip).includes('Quarterly update'))
  assert.equal(JSON.stringify(tree).includes(noTarget), false)
})

test('the panel accepts general chat without mail context and keeps answers non-applicable', async () => {
  const requests = []
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    getCodexModels: async () => ({ state: 'unavailable', reason: 'not_connected' }),
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () => ({ status: 'none' }),
    generateAiMailWithOllama: async (request) => {
      requests.push(request)
      return {
        ok: true,
        output: {
          kind: 'answer',
          text: '**I can answer without email context.** <img src=x onerror=alert(1)>'
        }
      }
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
  await new Promise(setImmediate)
  let tree = app.render()
  const composer = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  assert.notEqual(composer.props.disabled, true)
  composer.props.onChange({ target: { value: 'What can you do?' } })
  tree = app.render()
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Send').props
      .disabled,
    false
  )
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  tree = app.render()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].composeId, 'read-only')
  assert.match(requests[0].prompt, /What can you do\?/)
  assert.doesNotMatch(requests[0].prompt, /CURRENT RECEIVED EMAIL \(untrusted data\):/)
  assert.doesNotMatch(requests[0].prompt, /CURRENT COMPOSE DRAFT \(untrusted data\):/)
  assert.ok(
    findElement(
      tree,
      (node) =>
        node.props?.text?.includes('I can answer without email context.') &&
        node.props?.tone === undefined
    )
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'img'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'Apply to body'),
    null
  )
})

test('no-compose draft suggestion keeps target discovery available and explains how to open a draft', async () => {
  let targetQueries = 0
  const api = {
    getAiMailComposeTargetStatus: async () => {
      targetQueries += 1
      return { status: 'none' }
    },
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => read,
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => ({ status: 'none' }),
    generateAiMailWithOllama: async () => ({
      ok: true,
      output: { kind: 'proposal', subject: '안내 제목', body: '안내 본문' }
    })
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
    }
  })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const composer = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  composer.props.onChange({ target: { value: 'Write a reply' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  const editableProposal = findElement(
    tree,
    (node) => node.type === 'div' && node.props.className === 'ai-mail-proposal'
  )
  assert.ok(editableProposal)
  assert.ok(
    findElement(
      editableProposal,
      (node) => node.type === 'input' && node.props.value === '안내 제목'
    )
  )
  assert.ok(
    findElement(
      editableProposal,
      (node) => node.type === 'textarea' && node.props.value === '안내 본문'
    )
  )
  assert.ok(
    findElement(
      editableProposal,
      (node) => node.type === 'button' && node.props.children === 'Find a compose window'
    )
  )
  assert.ok(
    findElement(
      tree,
      (node) =>
        node.type === 'p' && JSON.stringify(node.props.children).includes('Open a compose window')
    )
  )
  findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Find a compose window'
  ).props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.ok(targetQueries > 1)
  assert.ok(JSON.stringify(tree).includes('Open a compose window'))
})

test('selecting an alternate compose opens a covered confirmation, and body-only never applies the subject', async () => {
  const calls = []
  const coveredStates = []
  let selected = false
  const candidateOne = { composeId: 'compose-recent', label: 'Most recent', lastUsedAt: 20 }
  const candidateTwo = { composeId: 'compose-other', label: 'Other draft', lastUsedAt: 10 }
  const freshSnapshot = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-other',
    accountLabel: 'A',
    documentVersion: 'fresh-version',
    snapshotId: 'fresh-snapshot',
    subject: 'Existing subject',
    recipients: [],
    body: 'Existing body',
    candidates: [candidateOne, candidateTwo]
  }
  const api = {
    getAiMailComposeTargetStatus: async () => ({
      status: 'none',
      candidates: [candidateOne, candidateTwo]
    }),
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () =>
      selected ? freshSnapshot : { status: 'none', candidates: [candidateOne, candidateTwo] },
    selectAiMailComposeTarget: async (request) => {
      calls.push(['select', request.composeId])
      selected = true
      return freshSnapshot
    },
    setSettingsPanelOpen: async (open) => {
      coveredStates.push(open)
      return open
        ? { accountId: 'account-a', dataUrl: 'data:image/png;base64,AA==', bounds: {} }
        : null
    },
    generateAiMailWithOllama: async () => ({
      ok: true,
      output: { kind: 'proposal', subject: 'Suggested subject', body: 'Suggested body' }
    }),
    applyAiMailSubject: async () => {
      calls.push(['subject'])
      return { status: 'applied', applyId: 'subject-id' }
    },
    applyAiMailDraft: async (request) => {
      calls.push(['body', request.replacement])
      return { status: 'applied', applyId: 'body-id' }
    },
    undoAiMailSubject: async () => ({ status: 'undone' }),
    undoAiMailDraft: async () => ({ status: 'undone' })
  }
  const app = setup(api)
  app.setProps({ open: true, settings: { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' } })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const input = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  input.props.onChange({ target: { value: 'Write an email' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  const proposal = findElement(
    tree,
    (node) => node.type === 'div' && node.props.className === 'ai-mail-proposal'
  )
  const select = findElement(
    proposal,
    (node) => node.type === 'select' && node.props['aria-label'] === 'Choose a draft to apply to'
  )
  assert.ok(select)
  assert.equal(
    findElement(
      proposal,
      (node) => node.type === 'button' && node.props.children === 'Review changes'
    ).props.disabled,
    true
  )
  assert.equal(
    findElement(select, (node) => node.type === 'option' && node.props.children === 'Other draft')
      ?.props.value,
    'compose-other'
  )
  select.props.onChange({ target: { value: 'compose-other' } })
  await new Promise(setImmediate)
  tree = app.render()
  const dialog = findElement(
    tree,
    (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
  )
  assert.ok(dialog, JSON.stringify(tree).slice(-2400))
  assert.deepEqual(calls, [['select', 'compose-other']])
  assert.deepEqual(coveredStates, [true])
  assert.ok(JSON.stringify(dialog).includes('Existing subject'))
  assert.ok(JSON.stringify(dialog).includes('Suggested body'))
  const bodyOnly = findElement(
    dialog,
    (node) => node.type === 'input' && node.props.type === 'radio' && !node.props.checked
  )
  assert.ok(bodyOnly)
  bodyOnly.props.onChange()
  tree = app.render()
  const updatedDialog = findElement(
    tree,
    (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
  )
  findElement(
    updatedDialog,
    (node) => node.type === 'button' && node.props.children === 'Apply draft'
  ).props.onClick()
  app.render()
  await new Promise(setImmediate)
  app.render()
  assert.deepEqual(calls, [
    ['select', 'compose-other'],
    ['body', 'Suggested body']
  ])
  assert.deepEqual(coveredStates, [true, false])
})

test('new conversation archives the current turn and earlier conversation selection restores it', async () => {
  const generationRequests = []
  const api = {
    getAiMailComposeTargetStatus: async () => ({ status: 'none' }),
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () => ({ status: 'none' }),
    generateAiMailWithOllama: async (request) => {
      generationRequests.push(request)
      return { ok: true, output: { kind: 'answer', text: 'Saved assistant reply' } }
    }
  }
  const app = setup(api)
  app.setProps({ open: true, settings: { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' } })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const input = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  input.props.onChange({ target: { value: 'Remember this turn' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  assert.ok(JSON.stringify(tree).includes('Saved assistant reply'))
  assert.match(generationRequests[0].conversationId, /^[0-9a-f-]{36}$/i)
  let followUp = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  followUp.props.onChange({ target: { value: 'Continue this conversation' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  assert.equal(generationRequests[1].conversationId, generationRequests[0].conversationId)
  // History lives behind the header's "Earlier conversations" button as a list of entries.
  const toggleHistory = (current) => {
    findElement(
      current,
      (node) => node.type === 'button' && node.props['aria-label'] === 'Earlier conversations'
    ).props.onClick()
    return app.render()
  }
  const historyList = (current) =>
    findElement(
      current,
      (node) => node.type === 'nav' && node.props['aria-label'] === 'Earlier conversations'
    )
  const historyEntries = (current) =>
    findElements(historyList(current), (node) => node.type === 'button')
  findElement(
    tree,
    (node) => node.type === 'button' && node.props['aria-label'] === 'New conversation'
  ).props.onClick()
  tree = app.render()
  const freshInput = findElement(
    tree,
    (node) => node.type === 'textarea' && node.props['aria-label']
  )
  freshInput.props.onChange({ target: { value: 'Start another conversation' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  assert.notEqual(generationRequests[2].conversationId, generationRequests[0].conversationId)
  assert.equal(historyList(tree), null, 'the list stays closed until asked for')
  tree = toggleHistory(tree)
  const savedEntries = historyEntries(tree)
  assert.equal(savedEntries.length, 1)
  assert.ok(JSON.stringify(savedEntries[0]).includes('Remember this turn'))
  const savedEntry = savedEntries[0]
  savedEntry.props.onClick()
  tree = app.render()
  assert.equal(historyList(tree), null, 'choosing an entry closes the list')
  const restoredInput = findElement(
    tree,
    (node) => node.type === 'textarea' && node.props['aria-label']
  )
  restoredInput.props.onChange({ target: { value: 'Resume the earlier conversation' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  assert.equal(generationRequests[3].conversationId, generationRequests[0].conversationId)
  tree = app.render()
  assert.ok(JSON.stringify(tree).includes('Remember this turn'))
  assert.ok(JSON.stringify(tree).includes('Saved assistant reply'))
  assert.ok(JSON.stringify(tree).includes(app.messages.en.aiMail.conversationRestored))
  tree = toggleHistory(tree)
  assert.ok(historyEntries(tree).length > 0, 'the conversation left behind is archived')
  app.setProps({ activeAccountId: 'account-b', captureSession: 1 })
  app.render()
  // An entry captured under account A cannot restore into account B.
  savedEntry.props.onClick()
  tree = app.render()
  assert.ok(JSON.stringify(tree).includes(app.messages.en.aiMail.conversationUnavailable))
  if (!historyList(tree)) tree = toggleHistory(tree)
  assert.equal(historyEntries(tree).length, 0, 'account B sees none of account A history')
  assert.ok(JSON.stringify(historyList(tree)).includes(app.messages.en.aiMail.noConversations))
  app.setProps({ activeAccountId: 'account-a', captureSession: 2 })
  app.render()
  tree = app.render()
  assert.ok(JSON.stringify(tree).includes('Remember this turn'))
  if (!historyList(tree)) tree = toggleHistory(tree)
  assert.ok(historyEntries(tree).length > 0)
  findElement(
    tree,
    (node) => node.type === 'button' && node.props['aria-label'] === 'New conversation'
  ).props.onClick()
  tree = app.render()
  tree = toggleHistory(tree)
  assert.ok(historyEntries(tree).length > 0)
})

test('a blank compose always opens confirmation before a proposal can be applied', async () => {
  const timers = []
  const subjectApplies = []
  const undoCalls = []
  let failFirstBodyUndo = true
  const coveredStates = []
  let targetStatus = { status: 'none' }
  let selected = false
  const freshDraft = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-current',
    accountLabel: 'A',
    documentVersion: 'version-4',
    snapshotId: 'snapshot-fresh',
    subject: '',
    recipients: [],
    body: '',
    candidates: [{ composeId: 'compose-current', label: 'Current draft', lastUsedAt: 2 }]
  }
  const api = {
    getAiMailComposeTargetStatus: async () => targetStatus,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () =>
      selected || targetStatus.status === 'ready' ? freshDraft : { status: 'none' },
    selectAiMailComposeTarget: async () => {
      selected = true
      return freshDraft
    },
    setSettingsPanelOpen: async (open) => {
      coveredStates.push(open)
      return open
        ? { accountId: 'account-a', dataUrl: 'data:image/png;base64,AA==', bounds: {} }
        : null
    },
    generateAiMailWithOllama: async () => ({
      ok: true,
      output: { kind: 'proposal', subject: 'Suggested subject', body: 'Suggested body' }
    }),
    applyAiMailSubject: async (request) => {
      subjectApplies.push(request)
      return { status: 'applied', applyId: 'apply-subject' }
    },
    applyAiMailDraft: async () => ({ status: 'applied', applyId: 'apply-body' }),
    undoAiMailSubject: async () => {
      undoCalls.push('subject')
      return { status: 'undone' }
    },
    undoAiMailDraft: async () => {
      undoCalls.push('body')
      if (failFirstBodyUndo) {
        failFirstBodyUndo = false
        return { status: 'failed' }
      }
      return { status: 'undone' }
    }
  }
  const app = setup(api, timers)
  app.setProps({ open: true, settings: { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' } })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const input = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  input.props.onChange({ target: { value: 'Write a reply' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  assert.ok(
    findElement(
      tree,
      (node) => node.type === 'button' && node.props.children === 'Find a compose window'
    )
  )

  targetStatus = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-current',
    accountLabel: 'A',
    recipients: [],
    subject: freshDraft.subject,
    candidates: freshDraft.candidates
  }
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  const refreshTimer = timers.find((timer) => timer.delay === 1500)
  assert.ok(
    refreshTimer,
    `expected target refresh timer; got ${timers.map((timer) => timer.delay)}`
  )
  refreshTimer.callback()
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Review changes'
  ).props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.ok(
    findElement(
      tree,
      (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
    )
  )
  assert.ok(JSON.stringify(tree).includes(app.messages.en.aiMail.emptyValue))
  assert.deepEqual(coveredStates, [true])
  assert.equal(
    findElement(
      tree,
      (node) => node.type === 'button' && node.props.children === 'Apply subject and body'
    ),
    null
  )
  const confirmation = findElement(
    tree,
    (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
  )
  findElement(
    confirmation,
    (node) => node.type === 'button' && node.props.children === 'Apply draft'
  ).props.onClick()
  await new Promise(setImmediate)
  await new Promise(setImmediate)
  tree = app.render()
  assert.equal(
    findElement(
      tree,
      (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
    ),
    null
  )
  assert.deepEqual(coveredStates, [true, false])
  assert.equal(subjectApplies.length, 1)
  assert.equal(subjectApplies[0].replacement, 'Suggested subject')
  const actions = findElement(
    tree,
    (node) => node.type === 'div' && node.props.className === 'ai-mail-proposal-actions'
  )
  assert.ok(actions)
  assert.equal((JSON.stringify(tree).match(/Undo applied revision/g) ?? []).length, 1)
  // The proposal has no copy action; apply / undo are the only actions.
  assert.equal((JSON.stringify(tree).match(/Copy revision/g) ?? []).length, 0)
  findElement(
    actions,
    (node) => node.type === 'button' && node.props.children === 'Undo applied revision'
  ).props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.deepEqual(undoCalls, ['body', 'subject'])
  assert.ok(JSON.stringify(tree).includes(app.messages.en.aiMail.undoPartial))
  assert.equal((JSON.stringify(tree).match(/Undo applied revision/g) ?? []).length, 1)
  findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Undo applied revision'
  ).props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.deepEqual(undoCalls, ['body', 'subject', 'body'])
  assert.equal((JSON.stringify(tree).match(/Undo applied revision/g) ?? []).length, 0)
})

test('review uses the visible ready compose when refreshed candidates omit it', async () => {
  const readyTarget = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-open',
    accountLabel: 'A',
    recipients: [],
    subject: 'Existing subject',
    candidates: [{ composeId: 'compose-other', label: 'Other draft', lastUsedAt: 10 }]
  }
  const snapshot = {
    ...readyTarget,
    documentVersion: 'version-a',
    snapshotId: 'snapshot-a',
    body: 'Existing body'
  }
  let selections = 0
  const api = {
    getAiMailComposeTargetStatus: async () => readyTarget,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    getAiMailComposeSnapshot: async () => snapshot,
    selectAiMailComposeTarget: async ({ accountId, composeId }) => {
      selections += 1
      assert.equal(accountId, 'account-a')
      assert.equal(composeId, 'compose-open')
      return snapshot
    },
    setSettingsPanelOpen: async (open) =>
      open ? { accountId: 'account-a', dataUrl: 'data:image/png;base64,AA==', bounds: {} } : null,
    generateAiMailWithOllama: async () => ({
      ok: true,
      output: { kind: 'proposal', subject: 'Suggested subject', body: 'Suggested body' }
    })
  }
  const app = setup(api)
  app.setProps({ open: true, settings: { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' } })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const input = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  input.props.onChange({ target: { value: 'Write an email' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  const review = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Review changes'
  )
  assert.ok(review)
  review.props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.equal(selections, 1)
  assert.ok(
    findElement(
      tree,
      (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
    )
  )
})

test('a compose edited after confirmation is rejected without a Gmail mutation', async () => {
  const candidate = { composeId: 'compose-a', label: 'Draft A', lastUsedAt: 1 }
  const pinned = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-a',
    accountLabel: 'A',
    documentVersion: 'version-a',
    snapshotId: 'snapshot-a',
    subject: 'Old subject',
    recipients: [],
    body: 'Old body',
    candidates: [candidate]
  }
  let latest = { status: 'none', candidates: [candidate] }
  const mutations = []
  const covered = []
  const api = {
    getAiMailComposeTargetStatus: async () => ({ status: 'none', candidates: [candidate] }),
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
    getOllamaModels: async () => [{ name: 'qwen3:8b', size: 10 }],
    cancelAiMailGeneration: async () => ({ cancelled: true }),
    cancelAiMailOllamaGeneration: async () => ({ cancelled: true }),
    getAiMailReadSnapshot: async () => ({ status: 'none' }),
    isAiMailReadSnapshotCurrent: async () => false,
    getAiMailComposeSnapshot: async () => latest,
    selectAiMailComposeTarget: async () => {
      latest = pinned
      return pinned
    },
    setSettingsPanelOpen: async (open) => {
      covered.push(open)
      return open
        ? { accountId: 'account-a', dataUrl: 'data:image/png;base64,AA==', bounds: {} }
        : null
    },
    generateAiMailWithOllama: async () => ({
      ok: true,
      output: { kind: 'proposal', subject: 'New subject', body: 'New body' }
    }),
    applyAiMailSubject: async () => {
      mutations.push('subject')
      return { status: 'applied', applyId: 'subject-id' }
    },
    applyAiMailDraft: async () => {
      mutations.push('body')
      return { status: 'applied', applyId: 'body-id' }
    },
    undoAiMailSubject: async () => ({ status: 'undone' })
  }
  const app = setup(api)
  app.setProps({ open: true, settings: { aiMailProvider: 'ollama', ollamaModel: 'qwen3:8b' } })
  app.render()
  await new Promise(setImmediate)
  let tree = app.render()
  const input = findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label'])
  input.props.onChange({ target: { value: 'Write an email' } })
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'form' && node.props.className === 'ai-mail-compose'
  ).props.onSubmit({ preventDefault: () => undefined })
  await new Promise(setImmediate)
  tree = app.render()
  findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Review changes'
  ).props.onClick()
  await new Promise(setImmediate)
  tree = app.render()
  assert.ok(
    findElement(
      tree,
      (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
    )
  )
  latest = { ...pinned, body: 'Changed while confirmation was open' }
  const confirm = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'Apply draft'
  )
  confirm.props.onClick()
  app.render()
  await new Promise(setImmediate)
  app.render()
  await new Promise(setImmediate)
  tree = app.render()
  assert.deepEqual(mutations, [])
  assert.equal(covered[0], true)
  assert.equal(covered.at(-1), false)
  assert.equal(
    findElement(
      tree,
      (node) => node.props?.role === 'alertdialog' && node.type?.name === 'AppDialog'
    ),
    null
  )
})

test('Ollama errors keep the composer editable and move retry controls to settings', async () => {
  let statusCalls = 0
  const api = {
    getAiMailComposeTargetStatus: async () => target,
    onAiMailComposeTarget: () => () => undefined,
    onAiMailCodexStatus: () => () => undefined,
    getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
    getOllamaStatus: async () => {
      statusCalls += 1
      throw new Error('fixture unavailable')
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
  assert.notEqual(textarea.props.disabled, true)
  textarea.props.onChange({ target: { value: 'Wait for Ollama' } })
  tree = app.render()
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Send').props
      .disabled,
    true
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'Try again'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props['aria-label'] === 'Send').props
      .disabled,
    true
  )
  assert.equal(statusCalls, 1)
})

test('Codex catalog and connection controls are managed in settings', async () => {
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
      return {
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
  codexStatusListener({ state: 'connected' })
  const tree = app.render()
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'Connect'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'option' && node.props.children === 'GPT Two'),
    null
  )
  assert.ok(findElement(tree, (node) => node.type === 'textarea' && node.props['aria-label']))
})

test('field mutation failures map to localized error and notice copy', () => {
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/messages/app-messages.ts', import.meta.url)
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
