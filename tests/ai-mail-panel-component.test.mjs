/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test harness uses plain JavaScript hooks and component props. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

function createHooks() {
  const slots = []
  const pendingEffects = []
  let index = 0
  const sameDeps = (left, right) =>
    left &&
    right &&
    left.length === right.length &&
    left.every((value, i) => Object.is(value, right[i]))
  const hooks = {
    beginRender() {
      index = 0
      pendingEffects.length = 0
    },
    useState(initial) {
      const slotIndex = index++
      if (!slots[slotIndex]) slots[slotIndex] = { value: initial }
      return [
        slots[slotIndex].value,
        (value) => {
          slots[slotIndex].value =
            typeof value === 'function' ? value(slots[slotIndex].value) : value
        }
      ]
    },
    useRef(initial) {
      const slotIndex = index++
      if (!slots[slotIndex]) slots[slotIndex] = { value: { current: initial } }
      return slots[slotIndex].value
    },
    useMemo(factory, deps) {
      const slotIndex = index++
      if (!slots[slotIndex] || !sameDeps(slots[slotIndex].deps, deps))
        slots[slotIndex] = { value: factory(), deps }
      return slots[slotIndex].value
    },
    useCallback(callback, deps) {
      return hooks.useMemo(() => callback, deps)
    },
    useEffect(callback, deps) {
      const slotIndex = index++
      const previous = slots[slotIndex]
      if (!previous || !sameDeps(previous.deps, deps)) {
        pendingEffects.push(() => {
          previous?.cleanup?.()
          const cleanup = callback()
          slots[slotIndex] = { deps, cleanup }
        })
      }
    },
    flushEffects() {
      for (const run of pendingEffects.splice(0)) run()
    }
  }
  return hooks
}

const targetA = {
  status: 'ready',
  accountId: 'account-a',
  composeId: 'compose-a',
  accountLabel: 'A',
  recipients: [],
  subject: 'Draft A'
}
const targetB = { ...targetA, composeId: 'compose-b', subject: 'Draft B' }
const targetC = {
  ...targetB,
  accountId: 'account-b',
  accountLabel: 'B',
  composeId: 'compose-c',
  subject: 'Draft C'
}
const captured = { ...targetA, documentVersion: 'v1', snapshotId: 's1', body: 'Captured body' }

function findElement(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const result = findElement(child, predicate)
      if (result) return result
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  const children = node.props?.children
  for (const child of Array.isArray(children) ? children : [children]) {
    const result = findElement(child, predicate)
    if (result) return result
  }
  return null
}

test('hidden mount refreshes when opened, polls while open, and ignores late query after close', async () => {
  const hooks = createHooks()
  let currentTarget = targetA
  let resolveLate
  let late = false
  let queryCount = 0
  const timers = []
  const fakeWindow = {
    api: {
      getAiMailComposeTargetStatus: () => {
        queryCount += 1
        if (late)
          return new Promise((resolve) => {
            resolveLate = resolve
          })
        return Promise.resolve(currentTarget)
      },
      onAiMailComposeTarget: () => () => {},
      onAiMailCodexStatus: () => () => {},
      getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
      getAiMailComposeSnapshot: async () => captured
    }
  }
  const { AiMailPanel } = loadTypeScript(
    new URL('../src/renderer/src/AiMailPanel.tsx', import.meta.url),
    {
      react: hooks,
      window: fakeWindow,
      setTimeout: (callback, delay) => {
        assert.equal(delay, 1500)
        timers.push(callback)
        return callback
      },
      clearTimeout: (timer) => {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      }
    }
  )
  const text = new Proxy({}, { get: (_target, key) => String(key) })
  let props = {
    activeAccountId: 'account-a',
    layoutMode: 'right',
    open: false,
    captureSession: 0,
    text,
    onClose: () => undefined
  }
  const render = () => {
    hooks.beginRender()
    const tree = AiMailPanel(props)
    hooks.flushEffects()
    return tree
  }

  render()
  assert.equal(queryCount, 0)
  props = { ...props, open: true }
  render()
  await new Promise(setImmediate)
  assert.equal(queryCount, 1)
  let tree = render()
  const captureButton = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'capture'
  )
  assert.ok(captureButton)
  await captureButton.props.onClick()
  await new Promise(setImmediate)
  tree = render()
  assert.ok(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body')
  )

  timers.shift()()
  await new Promise(setImmediate)
  tree = render()
  assert.ok(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body')
  )

  currentTarget = targetB
  timers.shift()()
  await new Promise(setImmediate)
  tree = render()
  assert.equal(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body'),
    null
  )

  late = true
  timers.shift()()
  assert.equal(queryCount, 4)
  props = { ...props, open: false, captureSession: 1 }
  assert.equal(render(), null)
  resolveLate(targetA)
  await new Promise(setImmediate)
  props = { ...props, open: true }
  late = false
  render()
  await new Promise(setImmediate)
  tree = render()
  assert.equal(queryCount, 5)
  assert.ok(findElement(tree, (node) => node.type === 'span' && node.props.children === 'Draft B'))

  late = true
  timers.shift()()
  props = { ...props, activeAccountId: 'account-b' }
  currentTarget = targetC
  late = false
  render()
  await new Promise(setImmediate)
  resolveLate(targetA)
  await new Promise(setImmediate)
  tree = render()
  assert.ok(findElement(tree, (node) => node.type === 'span' && node.props.children === 'Draft C'))
})

test('reopen hides the old target and capture until the fresh access status resolves', async () => {
  const hooks = createHooks()
  let currentStatus = targetA
  let deferQuery = false
  let resolveQuery
  const fakeWindow = {
    api: {
      getAiMailComposeTargetStatus: () =>
        deferQuery
          ? new Promise((resolve) => {
              resolveQuery = resolve
            })
          : Promise.resolve(currentStatus),
      onAiMailComposeTarget: () => () => {},
      onAiMailCodexStatus: () => () => {},
      getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
      getAiMailComposeSnapshot: async () => captured
    }
  }
  const timers = []
  const { AiMailPanel } = loadTypeScript(
    new URL('../src/renderer/src/AiMailPanel.tsx', import.meta.url),
    {
      react: hooks,
      window: fakeWindow,
      setTimeout: (callback) => {
        timers.push(callback)
        return callback
      },
      clearTimeout: (timer) => {
        const index = timers.indexOf(timer)
        if (index >= 0) timers.splice(index, 1)
      }
    }
  )
  const text = new Proxy({}, { get: (_target, key) => String(key) })
  let props = {
    activeAccountId: 'account-a',
    layoutMode: 'right',
    open: false,
    captureSession: 0,
    text,
    onClose: () => undefined
  }
  const render = () => {
    hooks.beginRender()
    const tree = AiMailPanel(props)
    hooks.flushEffects()
    return tree
  }
  const flush = () => new Promise(setImmediate)

  render()
  props = { ...props, open: true }
  render()
  await flush()
  let tree = render()
  const captureButton = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === 'capture'
  )
  assert.ok(captureButton)
  captureButton.props.onClick()
  await flush()
  tree = render()
  assert.ok(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body')
  )

  props = { ...props, open: false, captureSession: 1 }
  render()
  deferQuery = true
  props = { ...props, open: true }
  tree = render()
  assert.equal(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body'),
    null
  )
  resolveQuery(targetA)
  await flush()
  tree = render()
  assert.ok(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body')
  )

  props = { ...props, open: false, captureSession: 2 }
  render()
  currentStatus = { status: 'access_locked' }
  props = { ...props, open: true }
  tree = render()
  assert.equal(
    findElement(tree, (node) => node.type === 'span' && node.props.children === 'Draft A'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'capture'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body'),
    null
  )

  resolveQuery(currentStatus)
  await flush()
  tree = render()
  assert.equal(
    findElement(tree, (node) => node.type === 'button' && node.props.children === 'capture'),
    null
  )
  assert.equal(
    findElement(tree, (node) => node.type === 'pre' && node.props.children === 'Captured body'),
    null
  )
  assert.ok(
    findElement(tree, (node) => node.type === 'p' && node.props.children === 'lockedTarget')
  )
})

test('test response renders subject separately and summary has no body mutation action', async () => {
  const hooks = createHooks()
  const applied = []
  const fakeWindow = {
    api: {
      getAiMailComposeTargetStatus: async () => targetA,
      onAiMailComposeTarget: () => () => {},
      onAiMailCodexStatus: () => () => {},
      getAiMailCodexStatus: async () => ({ state: 'disconnected' }),
      getAiMailComposeSnapshot: async () => captured,
      applyAiMailDraft: async (request) => {
        applied.push(request)
        return { status: 'applied', applyId: 'apply-1' }
      }
    }
  }
  const { AiMailPanel } = loadTypeScript(
    new URL('../src/renderer/src/AiMailPanel.tsx', import.meta.url),
    {
      react: hooks,
      window: fakeWindow,
      setTimeout: () => 1,
      clearTimeout: () => undefined
    }
  )
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/app-messages.ts', import.meta.url)
  )
  let props = {
    activeAccountId: 'account-a',
    layoutMode: 'right',
    open: true,
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
  const flush = () => new Promise(setImmediate)

  render()
  await flush()
  let tree = render()
  const subjectTask = findElement(
    tree,
    (node) =>
      node.type === 'input' && node.props.name === 'ai-mail-task' && node.props.value === 'subject'
  )
  assert.ok(subjectTask)
  subjectTask.props.onChange()
  tree = render()
  const testButton = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === messages.en.aiMail.testResponse
  )
  assert.ok(testButton)
  testButton.props.onClick()
  await flush()
  tree = render()
  assert.ok(
    findElement(
      tree,
      (node) => node.type === 'p' && node.props.children === messages.en.aiMail.testSubject
    )
  )
  assert.ok(
    findElement(
      tree,
      (node) => node.type === 'pre' && node.props.children === messages.en.aiMail.testSuggestedBody
    )
  )
  const applyButton = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === messages.en.aiMail.apply
  )
  assert.ok(applyButton)
  applyButton.props.onClick()
  await flush()
  assert.equal(applied[0].replacement, messages.en.aiMail.testSuggestedBody)

  const summaryTask = findElement(
    tree,
    (node) =>
      node.type === 'input' && node.props.name === 'ai-mail-task' && node.props.value === 'summary'
  )
  summaryTask.props.onChange()
  tree = render()
  const summaryButton = findElement(
    tree,
    (node) => node.type === 'button' && node.props.children === messages.en.aiMail.testResponse
  )
  summaryButton.props.onClick()
  await flush()
  tree = render()
  assert.ok(
    findElement(
      tree,
      (node) => node.type === 'pre' && node.props.children === messages.en.aiMail.testSummary
    )
  )
  assert.equal(
    findElement(
      tree,
      (node) => node.type === 'button' && node.props.children === messages.en.aiMail.apply
    ),
    null
  )
})
