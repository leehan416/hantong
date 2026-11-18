/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Electron and DOM fixtures use plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { gmailReadTargetPageSource, createGmailReadTargetService } = loadTypeScript(
  new URL('../src/main/gmail-read-target.ts', import.meta.url)
)

class SyntheticElement {
  constructor(options = {}) {
    this.textContent = options.text ?? ''
    this.innerText = options.text ?? ''
    this.messageId = options.messageId ?? null
    this.parentElement = options.parent ?? null
    this.visible = options.visible !== false
    this.isConnected = true
    this.children = options.children ?? []
    for (const child of this.children) child.parentElement = this
  }

  getClientRects() {
    return this.visible ? [{}] : []
  }

  getAttribute(name) {
    return name === 'data-message-id' ? this.messageId : null
  }

  closest(selector) {
    if (selector === '[data-message-id]' && this.messageId) return this
    return this.parentElement?.closest(selector) ?? null
  }
}

function pageFixture(options = {}) {
  const roots = (
    options.messages ?? [{ id: 'message-1', subject: 'Received subject', body: 'Received body' }]
  ).map((message) => {
    const root = new SyntheticElement({ messageId: message.id })
    root.body = new SyntheticElement({ text: message.body, parent: root, visible: message.visible })
    return root
  })
  const headings = (options.subjects ?? ['Received subject']).map(
    (subject) => new SyntheticElement({ text: subject })
  )
  const main = {
    querySelectorAll(selector) {
      if (selector === 'h2') return headings
      if (selector === '[data-message-id] .a3s') return roots.map((root) => root.body)
      return []
    }
  }
  const document = {
    defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
    querySelector: (selector) => (selector === '[role="main"]' ? main : null)
  }
  for (const element of [...roots.map((root) => root.body), ...headings])
    element.ownerDocument = document
  const context = { document, Element: SyntheticElement }
  runInNewContext(gmailReadTargetPageSource('synthetic-document'), context)
  return { probe: context.__hantongReadMailTarget, roots }
}

test('read probe returns one visible open message as plain subject and body with an opaque id', () => {
  const page = pageFixture()
  const first = page.probe.read()
  const second = page.probe.read()

  assert.equal(first.status, 'ready')
  assert.deepEqual(JSON.parse(JSON.stringify(first.snapshot)), {
    targetId: first.snapshot.targetId,
    subject: 'Received subject',
    body: 'Received body'
  })
  assert.match(first.snapshot.targetId, /^read-\d+$/)
  assert.equal(second.snapshot.targetId, first.snapshot.targetId)
  assert.doesNotMatch(
    gmailReadTargetPageSource('synthetic-document'),
    /fetch\(|XMLHttpRequest|replaceChildren|dispatchEvent/
  )
})

test('read probe fails closed when the open message or subject is ambiguous', () => {
  assert.equal(
    pageFixture({
      messages: [
        { id: 'message-1', subject: 'Subject', body: 'Body one' },
        { id: 'message-2', subject: 'Subject', body: 'Body two' }
      ]
    }).probe.read().status,
    'unsupported'
  )
  assert.equal(
    pageFixture({ subjects: ['Subject one', 'Subject two'] }).probe.read().status,
    'unsupported'
  )
})

test('read probe ignores hidden messages and returns none when no open message is visible', () => {
  assert.equal(
    pageFixture({
      messages: [{ id: 'hidden', subject: 'Subject', body: 'Body', visible: false }]
    }).probe.read().status,
    'none'
  )
})

test('read probe target changes when Gmail reuses a message node for another id', () => {
  const page = pageFixture()
  const before = page.probe.read().snapshot.targetId
  page.roots[0].messageId = 'message-2'
  const after = page.probe.read().snapshot.targetId
  assert.notEqual(after, before)
})

function serviceFixture() {
  let activeAccountId = 'account-a'
  let ready = true
  let destroyed = false
  let revision = { navigationRevision: 4, accessRevision: 9 }
  let mail = { targetId: 'read-1', subject: 'Received subject', body: 'Received body' }
  const listeners = new Map()
  const contents = {
    isDestroyed: () => destroyed,
    on(name, listener) {
      listeners.set(name, listener)
      return this
    },
    removeListener(name) {
      listeners.delete(name)
      return this
    },
    async executeJavaScriptInIsolatedWorld(_world, scripts) {
      const code = scripts[0].code
      if (code.includes('__hantongReadMailTarget?.documentId ==='))
        return { status: 'ready', snapshot: mail }
      return true
    }
  }
  const service = createGmailReadTargetService({
    window: { isDestroyed: () => false },
    views: {
      getActiveAccountId: () => activeAccountId,
      getReadMailView: (accountId) =>
        ready && accountId === activeAccountId ? { contents, ...revision } : null
    },
    access: { getState: () => ({ status: ready ? 'ready' : 'required' }) },
    getAccounts: () => [{ id: 'account-a' }, { id: 'account-b' }]
  })
  return {
    service,
    listeners,
    setMail(value) {
      mail = value
    },
    setAccount(value) {
      activeAccountId = value
    },
    setReady(value) {
      ready = value
    },
    setRevision(value) {
      revision = value
    },
    destroy() {
      destroyed = true
    },
    emitNavigation() {
      listeners.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: true })
    }
  }
}

test('snapshot lease is invalidated when the opened email changes during generation', async () => {
  const fixture = serviceFixture()
  const snapshot = await fixture.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(await fixture.service.isSnapshotCurrent(snapshot.captureId), true)

  fixture.setMail({ targetId: 'read-2', subject: 'Another subject', body: 'Another body' })
  assert.equal(await fixture.service.isSnapshotCurrent(snapshot.captureId), false)
  fixture.service.dispose()
})

test('read snapshot leases fail closed after navigation, account switch or access lock', async () => {
  const navigation = serviceFixture()
  const first = await navigation.service.getSnapshot()
  navigation.emitNavigation()
  assert.equal(await navigation.service.isSnapshotCurrent(first.captureId), false)
  navigation.service.dispose()

  const account = serviceFixture()
  const second = await account.service.getSnapshot()
  account.setAccount('account-b')
  account.service.onAccountSwitch()
  assert.equal(await account.service.isSnapshotCurrent(second.captureId), false)
  account.service.dispose()

  const access = serviceFixture()
  const third = await access.service.getSnapshot()
  access.service.onAccessState({ accountId: 'account-a', status: 'required' })
  assert.equal(await access.service.isSnapshotCurrent(third.captureId), false)
  access.service.dispose()
})

test('read snapshot capture rejects a view that becomes inaccessible while page setup is pending', async () => {
  let finishInstall
  const fixture = serviceFixture()
  let installCount = 0
  const contents = {
    isDestroyed: () => false,
    on(name, listener) {
      fixture.listeners.set(name, listener)
      return this
    },
    removeListener(name) {
      fixture.listeners.delete(name)
      return this
    },
    executeJavaScriptInIsolatedWorld() {
      installCount += 1
      if (installCount > 1) return Promise.resolve(true)
      return new Promise((resolve) => {
        finishInstall = resolve
      })
    }
  }
  const service = createGmailReadTargetService({
    window: { isDestroyed: () => false },
    views: {
      getActiveAccountId: () => 'account-a',
      getReadMailView: () => ({ contents, navigationRevision: 1, accessRevision: 1 })
    },
    access: { getState: () => ({ status: 'ready' }) },
    getAccounts: () => [{ id: 'account-a' }]
  })
  const pending = service.getSnapshot()
  await Promise.resolve()
  fixture.listeners.get('did-start-navigation')?.({ isMainFrame: true, isSameDocument: false })
  finishInstall(true)
  assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { status: 'stale' })
  service.dispose()
})
