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
        node.type === 'p' && node.props.children === app.messages.en.aiMail.generationBlocked
    )
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
