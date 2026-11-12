/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Electron fixtures use plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailComposeTargetService } = loadTypeScript(
  new URL('../src/main/gmail-compose-target.ts', import.meta.url)
)
const { gmailComposeTargetPageSource } = loadTypeScript(
  new URL('../src/main/gmail-compose-target.ts', import.meta.url)
)
const { isAllowedAiMailComposeTargetRequest } = loadTypeScript(
  new URL('../src/main/security-policy.ts', import.meta.url)
)

const renderer = 'file:///Applications/Hantong.app/Contents/Resources/app/index.html'

function fixture(options = {}) {
  let activeAccountId = 'account-a'
  let ready = true
  let destroyed = false
  let targetId = 'target-7'
  let documentRevision = '4:9'
  let body = 'Synthetic body'
  const listeners = new Map()
  const contents = {
    id: 25,
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
      if (code.includes('__hantongComposeTarget.replace(')) {
        if (options.deferReplace) await options.deferReplace()
        const match = code.match(
          /\.replace\(("(?:\\.|[^"])*"), ("(?:\\.|[^"])*"), ("(?:\\.|[^"])*")\)/
        )
        if (!match) return null
        const expected = JSON.parse(match[2])
        const replacement = JSON.parse(match[3])
        if (body !== expected) return { status: 'conflict', body }
        body = replacement
        return { status: 'applied' }
      }
      if (code.includes('__hantongComposeTarget.readTarget(')) {
        if (options.deferReadBeforeReplace) await options.deferReadBeforeReplace()
        return {
          targetId,
          snapshot: {
            subject: 'Synthetic subject',
            recipients: ['recipient@example.test'],
            body,
            supported: options.supported !== false
          }
        }
      }
      if (code.includes('globalThis.__hantongComposeTarget?.documentId ===')) {
        if (options.deferRead) await options.deferRead()
        return {
          targetId,
          snapshot: {
            subject: 'Synthetic subject',
            recipients: ['recipient@example.test'],
            body,
            supported: options.supported !== false
          }
        }
      }
      return true
    }
  }
  const accounts = [
    { id: 'account-a', email: 'synthetic-a@example.test', displayName: 'Synthetic A' },
    { id: 'account-b', email: 'synthetic-b@example.test', displayName: 'Synthetic B' }
  ]
  const service = createGmailComposeTargetService({
    window: { isDestroyed: () => false },
    views: {
      getActiveAccountId: () => activeAccountId,
      getComposeProbeView: (accountId) =>
        ready && accountId === activeAccountId
          ? {
              contents,
              navigationRevision: Number(documentRevision.split(':')[0]),
              accessRevision: Number(documentRevision.split(':')[1])
            }
          : null
    },
    access: { getState: () => ({ status: ready ? 'ready' : 'required' }) },
    getAccounts: () => accounts
  })
  return {
    service,
    listeners,
    setAccount(accountId) {
      activeAccountId = accountId
    },
    setReady(value) {
      ready = value
    },
    setRevision(value) {
      documentRevision = value
    },
    setTarget(value) {
      targetId = value
    },
    setBody(value) {
      body = value
    },
    getBody() {
      return body
    },
    destroy() {
      destroyed = true
    }
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('snapshot request returns only bounded current compose data and opaque identity', async () => {
  const f = fixture()
  const status = await f.service.getStatus()
  assert.equal(status.status, 'ready')
  assert.equal(status.accountLabel, 'Synthetic A')
  assert.deepEqual(status.recipients, ['recipient@example.test'])
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.accountId, 'account-a')
  assert.equal(snapshot.composeId, status.composeId)
  assert.equal(snapshot.body, 'Synthetic body')
  assert.match(snapshot.documentVersion, /^[0-9a-f-]{36}$/)
  assert.equal(await f.service.isResultTargetCurrent(snapshot), true)
  f.service.dispose()
})

test('a target switch invalidates an already captured snapshot lease', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  f.setTarget('target-8')
  assert.equal(await f.service.isResultTargetCurrent(snapshot), false)
  f.service.dispose()
})

test('active account or document changes fence an in-flight snapshot', async () => {
  let resume
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const f = fixture({
    deferRead: async () => {
      started()
      await new Promise((resolve) => {
        resume = resolve
      })
    }
  })
  const pending = f.service.getSnapshot()
  await startedPromise
  f.setAccount('account-b')
  resume()
  assert.deepEqual(plain(await pending), { status: 'stale' })
  f.service.dispose()
})

test('explicit apply and undo mutate only the captured synthetic compose body', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  const applied = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(applied.status, 'applied')
  assert.equal(f.getBody(), 'Synthetic revised body')
  if (applied.status !== 'applied') assert.fail('synthetic apply should return an apply id')
  assert.deepEqual(
    plain(
      await f.service.undoDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        applyId: applied.applyId
      })
    ),
    { status: 'undone' }
  )
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('apply and undo conflicts require a fresh explicit current-version confirmation', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  f.setBody('Synthetic direct edit')
  const conflict = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(conflict.status, 'conflict')
  assert.equal(f.getBody(), 'Synthetic direct edit')
  if (conflict.status !== 'conflict') assert.fail('expected conflict confirmation token')
  const applied = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body',
    confirmedCurrentVersion: conflict.currentVersion
  })
  assert.equal(applied.status, 'applied')
  if (applied.status !== 'applied') assert.fail('expected apply id')
  f.setBody('Synthetic edit before undo')
  const undoConflict = await f.service.undoDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId: applied.applyId
  })
  assert.equal(undoConflict.status, 'conflict')
  assert.equal(f.getBody(), 'Synthetic edit before undo')
  if (undoConflict.status !== 'conflict') assert.fail('expected undo confirmation token')
  assert.deepEqual(
    plain(
      await f.service.undoDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        applyId: applied.applyId,
        confirmedCurrentVersion: undoConflict.currentVersion
      })
    ),
    { status: 'undone' }
  )
  assert.equal(f.getBody(), 'Synthetic direct edit')
  f.service.dispose()
})

test('apply confirmation is consumed when a newer body creates a second conflict', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  f.setBody('Synthetic body B')
  const firstConflict = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(firstConflict.status, 'conflict')
  if (firstConflict.status !== 'conflict') assert.fail('expected first apply conflict')

  f.setBody('Synthetic body C')
  const secondConflict = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body',
    confirmedCurrentVersion: firstConflict.currentVersion
  })
  assert.equal(secondConflict.status, 'conflict')
  if (secondConflict.status !== 'conflict') assert.fail('expected refreshed apply conflict')

  f.setBody('Synthetic body B')
  assert.deepEqual(
    plain(
      await f.service.applyDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        snapshotId: snapshot.snapshotId,
        replacement: 'Synthetic revised body',
        confirmedCurrentVersion: firstConflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )
  assert.equal(f.getBody(), 'Synthetic body B')

  f.setBody('Synthetic body C')
  const applied = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body',
    confirmedCurrentVersion: secondConflict.currentVersion
  })
  assert.equal(applied.status, 'applied')
  assert.equal(f.getBody(), 'Synthetic revised body')
  f.service.dispose()
})

test('undo confirmation is consumed when a newer body creates a second conflict', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  const applied = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(applied.status, 'applied')
  if (applied.status !== 'applied') assert.fail('expected apply id')

  f.setBody('Synthetic undo body B')
  const firstConflict = await f.service.undoDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId: applied.applyId
  })
  assert.equal(firstConflict.status, 'conflict')
  if (firstConflict.status !== 'conflict') assert.fail('expected first undo conflict')

  f.setBody('Synthetic undo body C')
  const secondConflict = await f.service.undoDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId: applied.applyId,
    confirmedCurrentVersion: firstConflict.currentVersion
  })
  assert.equal(secondConflict.status, 'conflict')
  if (secondConflict.status !== 'conflict') assert.fail('expected refreshed undo conflict')

  f.setBody('Synthetic undo body B')
  assert.deepEqual(
    plain(
      await f.service.undoDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        applyId: applied.applyId,
        confirmedCurrentVersion: firstConflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )
  assert.equal(f.getBody(), 'Synthetic undo body B')

  f.setBody('Synthetic undo body C')
  assert.deepEqual(
    plain(
      await f.service.undoDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        applyId: applied.applyId,
        confirmedCurrentVersion: secondConflict.currentVersion
      })
    ),
    { status: 'undone' }
  )
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('confirmation tokens cannot be replayed across apply and undo operations', async () => {
  const f = fixture()
  const firstSnapshot = await f.service.getSnapshot()
  assert.equal(firstSnapshot.status, 'ready')
  const applied = await f.service.applyDraft({
    accountId: firstSnapshot.accountId,
    composeId: firstSnapshot.composeId,
    documentVersion: firstSnapshot.documentVersion,
    snapshotId: firstSnapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(applied.status, 'applied')
  if (applied.status !== 'applied') assert.fail('expected apply id')

  const secondSnapshot = await f.service.getSnapshot()
  assert.equal(secondSnapshot.status, 'ready')
  f.setBody('Synthetic changed body')
  const conflict = await f.service.applyDraft({
    accountId: secondSnapshot.accountId,
    composeId: secondSnapshot.composeId,
    documentVersion: secondSnapshot.documentVersion,
    snapshotId: secondSnapshot.snapshotId,
    replacement: 'Another synthetic replacement'
  })
  assert.equal(conflict.status, 'conflict')
  if (conflict.status !== 'conflict') assert.fail('expected apply conflict')

  assert.deepEqual(
    plain(
      await f.service.undoDraft({
        accountId: firstSnapshot.accountId,
        composeId: firstSnapshot.composeId,
        documentVersion: firstSnapshot.documentVersion,
        applyId: applied.applyId,
        confirmedCurrentVersion: conflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )
  assert.deepEqual(
    plain(
      await f.service.applyDraft({
        accountId: secondSnapshot.accountId,
        composeId: secondSnapshot.composeId,
        documentVersion: secondSnapshot.documentVersion,
        snapshotId: secondSnapshot.snapshotId,
        replacement: 'Another synthetic replacement',
        confirmedCurrentVersion: conflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )
  assert.equal(f.getBody(), 'Synthetic changed body')
  f.service.dispose()
})

test('duplicate use of a confirmation token cannot bypass serialized apply', async () => {
  let deferReads = false
  let resume
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const f = fixture({
    deferReadBeforeReplace: async () => {
      if (!deferReads) return
      started()
      await new Promise((resolve) => {
        resume = resolve
      })
    }
  })
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  f.setBody('Synthetic changed body')
  const conflict = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  assert.equal(conflict.status, 'conflict')
  if (conflict.status !== 'conflict') assert.fail('expected apply conflict')

  deferReads = true
  const request = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body',
    confirmedCurrentVersion: conflict.currentVersion
  }
  const first = f.service.applyDraft(request)
  await startedPromise
  assert.deepEqual(plain(await f.service.applyDraft(request)), { status: 'busy' })
  resume()
  assert.equal((await first).status, 'applied')
  assert.deepEqual(plain(await f.service.applyDraft(request)), { status: 'stale_target' })
  assert.equal(f.getBody(), 'Synthetic revised body')
  f.service.dispose()
})

test('an account switch after an explicit apply request fences its late result', async () => {
  let resume
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const f = fixture({
    deferReadBeforeReplace: async () => {
      started()
      await new Promise((resolve) => {
        resume = resolve
      })
    }
  })
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  const applying = f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  })
  await startedPromise
  f.setAccount('account-b')
  resume()
  assert.deepEqual(plain(await applying), { status: 'stale_target' })
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('duplicate explicit apply clicks are serialized while the first mutation is pending', async () => {
  let resume
  let started
  const startedPromise = new Promise((resolve) => {
    started = resolve
  })
  const f = fixture({
    deferReadBeforeReplace: async () => {
      started()
      await new Promise((resolve) => {
        resume = resolve
      })
    }
  })
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  const request = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'Synthetic revised body'
  }
  const first = f.service.applyDraft(request)
  await startedPromise
  assert.deepEqual(plain(await f.service.applyDraft(request)), { status: 'busy' })
  resume()
  assert.equal((await first).status, 'applied')
  f.service.dispose()
})

test('unsupported compose body formats fail closed before apply', async () => {
  const f = fixture({ supported: false })
  assert.deepEqual(plain(await f.service.getSnapshot()), {
    status: 'unsupported',
    code: 'unsupported_content'
  })
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('compose-target IPC accepts no arguments from only the trusted renderer main frame', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: renderer,
    rendererUrl: renderer,
    args: []
  }
  assert.equal(isAllowedAiMailComposeTargetRequest(base), true)
  for (const changed of [
    { ...base, senderMatches: false },
    { ...base, mainFrameMatches: false },
    { ...base, senderUrl: 'https://mail.google.com/' },
    { ...base, args: ['account-a'] }
  ])
    assert.equal(isAllowedAiMailComposeTargetRequest(changed), false)
})

test('synthetic reply editor remains explicitly selected and carries no guessed subject', () => {
  class SyntheticElement {
    constructor(selector = '', parentElement = null, text = '') {
      this.selector = selector
      this.parentElement = parentElement
      this.innerText = text
      this.isConnected = true
      this.attributes = new Map()
      this.childNodes = text ? [{ nodeType: 3, textContent: text }] : []
    }
    replaceChildren(...nodes) {
      this.childNodes = nodes
      this.innerText = nodes
        .map((node) => (node.nodeName === 'BR' ? '\n' : node.textContent))
        .join('')
    }
    matches(selector) {
      return this.selector === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
    }
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]')
        return nodes.filter((node) => node.matches(selector) && this.contains(node))
      if (selector === 'input[name="subjectbox"]')
        return nodes.filter((node) => node.matches(selector) && this.contains(node))
      if (selector === '[email], input[name="to"]') return []
      return []
    }
    querySelector(selector) {
      return selector.includes('Reply') && this.contains(replyMarker) ? replyMarker : null
    }
    contains(node) {
      for (let item = node; item; item = item.parentElement) if (item === this) return true
      return false
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    }
    dispatchEvent(event) {
      this.lastEvent = event
      return true
    }
  }
  const root = new SyntheticElement('[role="dialog"]')
  const composeBranch = new SyntheticElement('div', root)
  const editor = new SyntheticElement(
    '[contenteditable="true"]',
    composeBranch,
    'Reply fixture body'
  )
  const replyMarker = new SyntheticElement('button[aria-label*="Reply"]', composeBranch)
  const nodes = [root, composeBranch, editor, replyMarker]
  const listeners = new Map()
  const document = {
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    createElement: (name) => ({ nodeType: 1, nodeName: name.toUpperCase() }),
    createTextNode: (textContent) => ({ nodeType: 3, textContent })
  }
  const context = {
    document,
    Element: SyntheticElement,
    HTMLInputElement: class extends SyntheticElement {},
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Event: class Event {
      constructor(_type, options) {
        this.bubbles = options?.bubbles === true
      }
    }
  }
  const source = gmailComposeTargetPageSource('synthetic-document-version')
  runInNewContext(source, context)
  listeners.get('click')({ target: editor })
  const result = context.__hantongComposeTarget.read()
  assert.equal(result.targetId, 'target-1')
  assert.equal(result.snapshot.subject, '')
  assert.equal(result.snapshot.body, 'Reply fixture body')
  assert.equal(result.snapshot.supported, true)
  const replaced = context.__hantongComposeTarget.replace(
    'target-1',
    'Reply fixture body',
    'Synthetic replacement'
  )
  assert.equal(replaced.status, 'applied')
  assert.equal(editor.innerText, 'Synthetic replacement')
  assert.equal(editor.lastEvent.bubbles, true)
  context.__hantongComposeTarget.revoke()
})

test('plain-text apply leaves synthetic subject, recipient and attachment nodes untouched', () => {
  class SyntheticElement {
    constructor(selector = '', parentElement = null, text = '') {
      this.selector = selector
      this.parentElement = parentElement
      this.innerText = text
      this.isConnected = true
      this.attributes = new Map()
      this.childNodes = text ? [{ nodeType: 3, textContent: text }] : []
      this.children = []
      this.value = ''
    }
    replaceChildren(...nodes) {
      this.childNodes = nodes
      this.innerText = nodes
        .map((node) => (node.nodeName === 'BR' ? '\n' : node.textContent))
        .join('')
    }
    append(child) {
      child.parentElement = this
      this.children.push(child)
      return child
    }
    matches(selector) {
      return this.selector === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
    }
    contains(node) {
      for (let item = node; item; item = item.parentElement) if (item === this) return true
      return false
    }
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]') return [editor]
      if (selector === 'input[name="subjectbox"]') return [subject]
      if (selector === '[email], input[name="to"]') return [recipient]
      return []
    }
    querySelector() {
      return null
    }
    getAttribute(name) {
      return this.attributes.get(name) ?? null
    }
    dispatchEvent(event) {
      this.lastEvent = event
      return true
    }
  }
  class SyntheticInput extends SyntheticElement {}
  const root = new SyntheticElement('compose-root')
  const editor = root.append(
    new SyntheticElement('[contenteditable="true"]', null, 'Original body')
  )
  const subject = root.append(new SyntheticInput('input[name="subjectbox"]'))
  subject.value = 'Preserved subject'
  const recipient = root.append(new SyntheticElement('[email]'))
  recipient.attributes.set('email', 'person@example.test')
  const attachment = root.append(new SyntheticElement('attachment'))
  const listeners = new Map()
  const context = {
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
      createElement: (name) => ({ nodeType: 1, nodeName: name.toUpperCase() }),
      createTextNode: (textContent) => ({ nodeType: 3, textContent })
    },
    Element: SyntheticElement,
    HTMLInputElement: SyntheticInput,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    Event: class Event {
      constructor(_type, options) {
        this.bubbles = options?.bubbles === true
      }
    }
  }
  runInNewContext(gmailComposeTargetPageSource('synthetic-preservation-document'), context)
  listeners.get('click')({ target: editor })
  const read = context.__hantongComposeTarget.read()
  assert.equal(read.snapshot.subject, 'Preserved subject')
  assert.deepEqual(plain(read.snapshot.recipients), ['person@example.test'])
  assert.equal(
    context.__hantongComposeTarget.replace('target-1', 'Original body', 'Replacement body').status,
    'applied'
  )
  assert.equal(editor.innerText, 'Replacement body')
  assert.equal(subject.value, 'Preserved subject')
  assert.equal(recipient.getAttribute('email'), 'person@example.test')
  assert.equal(attachment.isConnected, true)
  assert.equal(root.children.includes(attachment), true)
  context.__hantongComposeTarget.revoke()
})

test('an unrelated reply marker in a shared ancestor cannot classify the editor as a reply', () => {
  class SyntheticElement {
    constructor(selector = '', parentElement = null, text = '') {
      this.selector = selector
      this.parentElement = parentElement
      this.innerText = text
      this.isConnected = true
    }
    matches(selector) {
      return this.selector === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
    }
    contains(node) {
      for (let item = node; item; item = item.parentElement) if (item === this) return true
      return false
    }
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]')
        return nodes.filter(
          (node) => node.matches(selector) && node !== this && this.contains(node)
        )
      if (selector === 'input[name="subjectbox"]') return []
      return []
    }
    querySelector(selector) {
      return selector.includes('Reply') && this.contains(replyMarker) ? replyMarker : null
    }
    querySelectorAllForRecipient() {
      return []
    }
    getAttribute() {
      return null
    }
  }
  const dialog = new SyntheticElement('[role="dialog"]')
  const editorBranch = new SyntheticElement('div', dialog)
  const editor = new SyntheticElement('[contenteditable="true"]', editorBranch, 'Unrelated body')
  const unrelatedControls = new SyntheticElement('div', dialog)
  const replyMarker = new SyntheticElement('button[aria-label*="Reply"]', unrelatedControls)
  const nodes = [dialog, editorBranch, editor, unrelatedControls, replyMarker]
  const listeners = new Map()
  const context = {
    document: {
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener() {
        return listeners.clear()
      }
    },
    Element: SyntheticElement,
    HTMLInputElement: class extends SyntheticElement {}
  }
  runInNewContext(gmailComposeTargetPageSource('synthetic-shared-ancestor'), context)
  listeners.get('click')({ target: editor })
  const result = context.__hantongComposeTarget.read()
  assert.deepEqual(plain(result), { targetId: 'unsupported', unsupported: true, snapshot: null })
})

test('snapshot IPC rejects a ready result whose Main target lease changed before delivery', async () => {
  const handlers = new Map()
  const electron = {
    app: {},
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    nativeTheme: {},
    webContents: { getAllWebContents: () => [] }
  }
  const { registerMainIpc } = loadTypeScript(new URL('../src/main/main-ipc.ts', import.meta.url), {
    electron
  })
  let activeAccountId = 'account-a'
  const ownerContents = {
    send() {
      return undefined
    }
  }
  const owner = { webContents: ownerContents, isDestroyed: () => false }
  let statusCalls = 0
  const service = {
    async getSnapshot() {
      queueMicrotask(() => {
        activeAccountId = 'account-b'
      })
      return {
        status: 'ready',
        accountId: 'account-a',
        composeId: 'compose-a',
        documentVersion: 'version-a',
        subject: 'Synthetic',
        recipients: [],
        body: 'Fixture'
      }
    },
    async getStatus() {
      statusCalls += 1
      return await new Promise((resolve) => {
        queueMicrotask(() =>
          resolve({ status: activeAccountId === 'account-b' ? 'none' : 'ready' })
        )
      })
    },
    async isResultTargetCurrent() {
      return true
    },
    isResultCurrent(result) {
      return activeAccountId === result.accountId
    }
  }
  const dependencies = {
    rendererUrl: renderer,
    window: () => owner,
    views: () => null,
    access: () => null,
    notifications: () => null,
    settings: () => null,
    isQuitting: () => false,
    requireAccountStore: () => ({}),
    requireAccountRemoval: () => ({}),
    requireGoogleRuntime: () => ({}),
    recovery: {},
    gmailCleanup: {},
    unreadCounts: () => ({ unreadCounts: () => new Map() }),
    locale: () => 'en',
    activateView() {
      return undefined
    },
    publishAccountState() {
      return undefined
    },
    installAppMenu() {
      return undefined
    },
    createWindow() {
      return undefined
    },
    loginLaunch: {},
    aiMailCodex: {},
    composeTarget: () => service
  }
  registerMainIpc(dependencies)
  const mainFrame = { url: renderer }
  ownerContents.mainFrame = mainFrame
  const sender = ownerContents
  const handler = handlers.get('hantong:ai-mail-compose-snapshot')
  const response = await handler({
    sender,
    senderFrame: mainFrame
  })
  assert.deepEqual(plain(response), { status: 'stale' })
  assert.equal(statusCalls, 0)
})

test('snapshot IPC rejects a renderer that navigates while the snapshot is pending', async () => {
  const handlers = new Map()
  const electron = {
    app: {},
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    nativeTheme: {},
    webContents: { getAllWebContents: () => [] }
  }
  const { registerMainIpc } = loadTypeScript(new URL('../src/main/main-ipc.ts', import.meta.url), {
    electron
  })
  const mainFrame = { url: renderer }
  const ownerContents = {
    mainFrame,
    send() {
      return undefined
    }
  }
  const owner = { webContents: ownerContents, isDestroyed: () => false }
  const result = {
    status: 'ready',
    accountId: 'account-a',
    composeId: 'compose-a',
    accountLabel: 'Synthetic A',
    documentVersion: 'opaque-version',
    subject: 'Synthetic subject',
    recipients: [],
    body: 'Synthetic body'
  }
  const service = {
    async getSnapshot() {
      queueMicrotask(() => {
        mainFrame.url = 'https://mail.google.com/'
      })
      return result
    },
    async getStatus() {
      return { status: 'none' }
    },
    async isResultTargetCurrent() {
      return true
    },
    isResultCurrent() {
      return true
    }
  }
  const dependencies = {
    rendererUrl: renderer,
    window: () => owner,
    views: () => null,
    access: () => null,
    notifications: () => null,
    settings: () => null,
    isQuitting: () => false,
    requireAccountStore: () => ({}),
    requireAccountRemoval: () => ({}),
    requireGoogleRuntime: () => ({}),
    recovery: {},
    gmailCleanup: {},
    unreadCounts: () => ({ unreadCounts: () => new Map() }),
    locale: () => 'en',
    activateView() {
      return undefined
    },
    publishAccountState() {
      return undefined
    },
    installAppMenu() {
      return undefined
    },
    createWindow() {
      return undefined
    },
    loginLaunch: {},
    aiMailCodex: {},
    composeTarget: () => service
  }
  registerMainIpc(dependencies)
  const handler = handlers.get('hantong:ai-mail-compose-snapshot')
  await assert.rejects(
    handler({ sender: ownerContents, senderFrame: mainFrame }),
    /Request rejected/
  )
})
