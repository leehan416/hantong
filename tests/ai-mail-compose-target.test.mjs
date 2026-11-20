/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Electron fixtures use plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createGmailComposeTargetService } = loadTypeScript(
  new URL('../src/main/gmail/gmail-compose-target.ts', import.meta.url)
)
const { gmailComposeTargetPageSource } = loadTypeScript(
  new URL('../src/main/gmail/gmail-compose-target.ts', import.meta.url)
)
const { isAllowedAiMailComposeTargetRequest } = loadTypeScript(
  new URL('../src/main/security/security-policy.ts', import.meta.url)
)

const renderer = 'file:///Applications/Hantong.app/Contents/Resources/app/index.html'

function fixture(options = {}) {
  let activeAccountId = 'account-a'
  let ready = true
  let visible = true
  let minimized = false
  let destroyed = false
  let targetId = 'target-7'
  let documentRevision = '4:9'
  let body = 'Synthetic body'
  let subject = 'Synthetic subject'
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
      if (code.includes('__hantongComposeTarget.selectTarget(')) {
        const match = code.match(/\.selectTarget\(("(?:\\.|[^"])*")\)/)
        if (!match) return false
        const requestedTarget = JSON.parse(match[1])
        if (requestedTarget !== targetId) return false
        return true
      }
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
      if (code.includes('__hantongComposeTarget.replaceSubject(')) {
        const match = code.match(
          /\.replaceSubject\(("(?:\\.|[^"])*"), ("(?:\\.|[^"])*"), ("(?:\\.|[^"])*")\)/
        )
        if (!match) return null
        const expected = JSON.parse(match[2])
        const replacement = JSON.parse(match[3])
        if (subject !== expected) return { status: 'conflict', body: subject }
        subject = replacement
        return { status: 'applied' }
      }
      if (code.includes('__hantongComposeTarget.readTarget(')) {
        if (options.deferReadBeforeReplace) await options.deferReadBeforeReplace()
        return {
          targetId,
          targets: [
            {
              targetId,
              title: subject || 'recipient@example.test',
              subject,
              recipients: ['recipient@example.test'],
              supported: options.supported !== false,
              lastUsedAt: 123
            }
          ],
          snapshot: {
            subject,
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
          targets: [
            {
              targetId,
              title: subject || 'recipient@example.test',
              subject,
              recipients: ['recipient@example.test'],
              supported: options.supported !== false,
              lastUsedAt: 123
            }
          ],
          snapshot: {
            subject,
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
    window: {
      isDestroyed: () => false,
      isVisible: () => visible,
      isMinimized: () => minimized
    },
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
    setWindowState(nextVisible, nextMinimized) {
      visible = nextVisible
      minimized = nextMinimized
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
    setSubject(value) {
      subject = value
    },
    getSubject() {
      return subject
    },
    destroy() {
      destroyed = true
    }
  }
}

function composeProbeFixture() {
  const listeners = new Map()
  const observers = []
  const scheduled = []
  const composeItems = []
  let now = 100

  class SyntheticElement {
    constructor(selector = '', parentElement = null, text = '') {
      this.selector = selector
      this.parentElement = parentElement
      this.children = []
      this.innerText = text
      this.value = ''
      this.isConnected = true
      this.childNodes = text ? [{ nodeType: 3, textContent: text }] : []
      parentElement?.children.push(this)
    }
    matches(selector) {
      return this.selector === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
    }
    getClientRects() {
      return this.isConnected && this.visible !== false ? [{ width: 120, height: 24 }] : []
    }
    querySelectorAll(selector) {
      const matches = []
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selector)) matches.push(child)
          visit(child)
        }
      }
      for (const child of this.children) {
        if (child.matches(selector)) matches.push(child)
        visit(child)
      }
      return matches
    }
    querySelector() {
      return null
    }
    getAttribute(name) {
      return name === 'aria-placeholder' || name === 'data-placeholder' ? null : null
    }
    replaceChildren(...nodes) {
      this.childNodes = nodes
      this.innerText = nodes.map((node) => node.textContent ?? '\n').join('')
    }
    dispatchEvent() {
      return true
    }
  }
  class SyntheticInput extends SyntheticElement {}
  class SyntheticObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe() {
      return undefined
    }
    disconnect() {
      return undefined
    }
  }

  const document = {
    documentElement: {},
    querySelectorAll: (selector) =>
      selector === '[contenteditable="true"]'
        ? composeItems.filter((item) => item.editor.isConnected).map((item) => item.editor)
        : [],
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name) => listeners.delete(name),
    createElement: (name) => ({ nodeType: 1, nodeName: name.toUpperCase() }),
    createTextNode: (textContent) => ({ nodeType: 3, textContent })
  }
  const context = {
    document,
    Element: SyntheticElement,
    HTMLInputElement: SyntheticInput,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: SyntheticObserver,
    Date: { now: () => now },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    clearTimeout: () => undefined,
    Event: class Event {}
  }
  runInNewContext(gmailComposeTargetPageSource('recency-fixture'), context)

  return {
    probe: context.__hantongComposeTarget,
    // Gmail nests the body editor more than 12 elements below the element it shares with
    // the subject box (seen in live structure diagnostics).
    addDeepCompose(label, depth) {
      const root = new SyntheticElement('compose-root')
      let parent = root
      for (let level = 0; level < depth; level += 1) parent = new SyntheticElement('div', parent)
      const editor = new SyntheticElement('[contenteditable="true"]', parent, 'Draft body')
      const subject = new SyntheticInput('input[name="subjectbox"]', root)
      subject.value = label
      const item = { root, editor, subject }
      composeItems.push(item)
      return item
    },
    addCompose(label) {
      const root = new SyntheticElement('compose-root')
      const editor = new SyntheticElement('[contenteditable="true"]', root, 'Draft body')
      const subject = new SyntheticInput('input[name="subjectbox"]', root)
      subject.value = label
      const item = { root, editor, subject }
      composeItems.push(item)
      return item
    },
    addUnmatchedEditor() {
      const editor = new SyntheticElement('[contenteditable="true"]', null, 'Unmatched')
      composeItems.push({ editor })
      return editor
    },
    addHiddenCompose(label) {
      const item = this.addCompose(label)
      item.editor.visible = false
      return item
    },
    setNow(value) {
      now = value
    },
    focus(editor) {
      listeners.get('focusin')({ target: editor })
    },
    discoverLater() {
      observers[0].callback()
      const timer = scheduled.at(-1)
      assert.equal(timer.delay, 100)
      timer.callback()
    }
  }
}

const plain = (value) => JSON.parse(JSON.stringify(value))

test('an inline reply with Gmail hidden subject box is discovered without a subject', () => {
  const fixture = composeProbeFixture()
  const reply = fixture.addDeepCompose('Re: kept by Gmail', 20)
  reply.subject.visible = false
  const result = plain(fixture.probe.read())
  assert.equal(result.discovery.candidateCount, 1)
  assert.equal(result.discovery.rejectedNotVisible, 0)
  assert.equal(result.targets.length, 1)
  assert.equal(result.targets[0].subject, '')
})

test('a compose whose body sits deep below the subject box is still discovered', () => {
  const fixture = composeProbeFixture()
  fixture.addDeepCompose('Deep draft', 20)
  const result = plain(fixture.probe.read())
  assert.equal(result.discovery.candidateCount, 1)
  assert.equal(result.discovery.rejectedNoMatch, 0)
  assert.equal(result.targets.length, 1)
})

test('two deep composes stay separate targets', () => {
  const fixture = composeProbeFixture()
  fixture.addDeepCompose('First deep draft', 20)
  fixture.addDeepCompose('Second deep draft', 20)
  const result = plain(fixture.probe.read())
  assert.equal(result.discovery.candidateCount, 2)
  assert.equal(result.targets.length, 2)
})

test('DOM discovery reports bounded editor and fixed rejection counts without DOM content', () => {
  const fixture = composeProbeFixture()
  for (let index = 0; index < 33; index += 1) fixture.addCompose(`Draft ${index}`)
  fixture.addHiddenCompose('Hidden draft')
  fixture.addUnmatchedEditor()
  const result = plain(fixture.probe.read())
  const { structure, ...counts } = result.discovery
  assert.deepEqual(counts, {
    editorCount: 35,
    candidateCount: 33,
    rejectedNoMatch: 1,
    rejectedNotVisible: 1,
    capacityEvictions: 1
  })
  assert.doesNotMatch(JSON.stringify(counts), /Draft|Unmatched|subject|recipient|target-/i)
  // Structure keys name DOM features (e.g. subjectBoxCount), so check its values instead:
  // only counts, flags and the fixed tag categories may leave the page.
  const leaves = (value) =>
    value && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]
  assert.ok(structure && typeof structure === 'object')
  for (const leaf of leaves(structure)) {
    assert.ok(
      typeof leaf === 'number' ||
        typeof leaf === 'boolean' ||
        ['document', 'container', 'form', 'input', 'other'].includes(leaf),
      `unexpected structure value: ${String(leaf)}`
    )
  }
})

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

test('candidate selection returns a fresh snapshot for its opaque identity', async () => {
  const f = fixture()
  const status = await f.service.getStatus()
  assert.equal(status.status, 'ready')
  if (status.status !== 'ready') assert.fail('compose status should be ready')
  assert.equal(status.candidates.length, 1)
  assert.equal(status.candidates[0].label, 'Synthetic subject')
  assert.notEqual(status.candidates[0].composeId, 'target-7')
  const snapshot = await f.service.selectTarget({
    accountId: 'account-a',
    composeId: status.candidates[0].composeId
  })
  assert.equal(snapshot.status, 'ready')
  if (snapshot.status !== 'ready') assert.fail('explicit target selection should return a snapshot')
  assert.equal(snapshot.composeId, status.candidates[0].composeId)
  assert.equal(snapshot.body, 'Synthetic body')
  f.service.dispose()
})

test('removed compose candidates cannot be explicitly selected', async () => {
  const f = fixture()
  const status = await f.service.getStatus()
  assert.equal(status.status, 'ready')
  if (status.status !== 'ready') assert.fail('compose status should be ready')
  const staleIdentity = status.candidates[0].composeId
  f.setTarget('target-8')
  const refreshed = await f.service.getStatus()
  assert.equal(refreshed.status, 'ready')
  if (refreshed.status !== 'ready') assert.fail('updated compose should be ready')
  assert.equal(
    (await f.service.selectTarget({ accountId: 'account-a', composeId: staleIdentity })).status,
    'stale'
  )
  f.service.dispose()
})

test('a replaced compose candidate is rejected before any editor mutation', async () => {
  const f = fixture()
  const status = await f.service.getStatus()
  assert.equal(status.status, 'ready')
  if (status.status !== 'ready') assert.fail('compose status should be ready')
  const staleIdentity = status.candidates[0].composeId
  f.setTarget('target-replaced')
  assert.equal(
    (await f.service.selectTarget({ accountId: 'account-a', composeId: staleIdentity })).status,
    'stale'
  )
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('compose probe tracks subject and focused descendants while guarding non-compose editors', () => {
  const source = gmailComposeTargetPageSource('document-test')
  assert.match(source, /document\.addEventListener\('focusin', remember, true\)/)
  assert.match(source, /document\.addEventListener\('click', remember, true\)/)
  assert.match(source, /node\.closest\('\[contenteditable="true"\]'\)/)
  assert.match(source, /input\[name="subjectbox"\]/)
  assert.match(source, /replyMarker/)
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

test('hidden or minimized owner windows cannot select or mutate a compose', async () => {
  for (const state of [
    { visible: false, minimized: false },
    { visible: true, minimized: true }
  ]) {
    const f = fixture()
    const status = await f.service.getStatus()
    assert.equal(status.status, 'ready')
    if (status.status !== 'ready') assert.fail('visible compose should be available')
    f.setWindowState(state.visible, state.minimized)
    assert.equal(
      (await f.service.selectTarget({ accountId: 'account-a', composeId: status.composeId }))
        .status,
      'stale'
    )
    const snapshot = await f.service.getSnapshot()
    assert.equal(snapshot.status, 'none')
    assert.equal(f.getBody(), 'Synthetic body')
    f.service.dispose()
  }
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

test('focus changes fence an undo receipt before it can reach another compose', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  const applied = await f.service.applyDraft({
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'First compose revision'
  })
  assert.equal(applied.status, 'applied')
  if (applied.status !== 'applied') assert.fail('apply should return an undo receipt')
  f.setTarget('target-8')
  const otherTarget = await f.service.getStatus()
  assert.equal(otherTarget.status, 'ready')
  assert.notEqual(otherTarget.composeId, snapshot.composeId)
  assert.equal(
    (
      await f.service.undoDraft({
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        applyId: applied.applyId
      })
    ).status,
    'stale_target'
  )
  assert.equal(f.getBody(), 'First compose revision')
  f.service.dispose()
})

test('body and subject apply and undo remain independent in either apply order', async () => {
  for (const subjectFirst of [false, true]) {
    const f = fixture()
    const snapshot = await f.service.getSnapshot()
    assert.equal(snapshot.status, 'ready')
    const bodyRequest = {
      accountId: snapshot.accountId,
      composeId: snapshot.composeId,
      documentVersion: snapshot.documentVersion,
      snapshotId: snapshot.snapshotId,
      replacement: 'Revised synthetic body'
    }
    const subjectRequest = { ...bodyRequest, replacement: 'Revised synthetic subject' }
    let bodyApply
    let subjectApply
    if (subjectFirst) {
      subjectApply = await f.service.applySubject(subjectRequest)
      bodyApply = await f.service.applyDraft(bodyRequest)
    } else {
      bodyApply = await f.service.applyDraft(bodyRequest)
      subjectApply = await f.service.applySubject(subjectRequest)
    }
    assert.equal(bodyApply.status, 'applied')
    assert.equal(subjectApply.status, 'applied')
    assert.equal(f.getBody(), 'Revised synthetic body')
    assert.equal(f.getSubject(), 'Revised synthetic subject')
    if (bodyApply.status !== 'applied' || subjectApply.status !== 'applied')
      assert.fail('both independent mutations should return apply ids')

    const subjectUndoRequest = {
      accountId: snapshot.accountId,
      composeId: snapshot.composeId,
      documentVersion: snapshot.documentVersion,
      applyId: subjectApply.applyId
    }
    const bodyUndoRequest = {
      accountId: snapshot.accountId,
      composeId: snapshot.composeId,
      documentVersion: snapshot.documentVersion,
      applyId: bodyApply.applyId
    }
    if (subjectFirst) {
      assert.deepEqual(plain(await f.service.undoDraft(bodyUndoRequest)), { status: 'undone' })
      assert.equal(f.getBody(), 'Synthetic body')
      assert.equal(f.getSubject(), 'Revised synthetic subject')
      assert.deepEqual(plain(await f.service.undoSubject(subjectUndoRequest)), { status: 'undone' })
    } else {
      assert.deepEqual(plain(await f.service.undoSubject(subjectUndoRequest)), { status: 'undone' })
      assert.equal(f.getBody(), 'Revised synthetic body')
      assert.equal(f.getSubject(), 'Synthetic subject')
      assert.deepEqual(plain(await f.service.undoDraft(bodyUndoRequest)), { status: 'undone' })
    }
    assert.equal(f.getBody(), 'Synthetic body')
    assert.equal(f.getSubject(), 'Synthetic subject')
    f.service.dispose()
  }
})

test('a later body apply preserves earlier body undo receipts', async () => {
  const f = fixture()
  const firstSnapshot = await f.service.getSnapshot()
  assert.equal(firstSnapshot.status, 'ready')
  const first = await f.service.applyDraft({
    accountId: firstSnapshot.accountId,
    composeId: firstSnapshot.composeId,
    documentVersion: firstSnapshot.documentVersion,
    snapshotId: firstSnapshot.snapshotId,
    replacement: 'First proposal'
  })
  assert.equal(first.status, 'applied')
  if (first.status !== 'applied') assert.fail('first apply should return an undo receipt')
  const secondSnapshot = await f.service.getSnapshot()
  assert.equal(secondSnapshot.status, 'ready')
  const second = await f.service.applyDraft({
    accountId: secondSnapshot.accountId,
    composeId: secondSnapshot.composeId,
    documentVersion: secondSnapshot.documentVersion,
    snapshotId: secondSnapshot.snapshotId,
    replacement: 'Second proposal'
  })
  assert.equal(second.status, 'applied')
  const undoSecond = await f.service.undoDraft({
    accountId: secondSnapshot.accountId,
    composeId: secondSnapshot.composeId,
    documentVersion: secondSnapshot.documentVersion,
    applyId: second.applyId
  })
  assert.deepEqual(plain(undoSecond), { status: 'undone' })
  const undoFirst = await f.service.undoDraft({
    accountId: firstSnapshot.accountId,
    composeId: firstSnapshot.composeId,
    documentVersion: firstSnapshot.documentVersion,
    applyId: first.applyId
  })
  assert.deepEqual(plain(undoFirst), { status: 'undone' })
  assert.equal(f.getBody(), 'Synthetic body')
  f.service.dispose()
})

test('subject apply and undo conflicts require fresh single-use confirmation', async () => {
  const f = fixture()
  const snapshot = await f.service.getSnapshot()
  assert.equal(snapshot.status, 'ready')
  f.setSubject('Direct subject edit')
  const request = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement: 'AI subject'
  }
  const conflict = await f.service.applySubject(request)
  assert.equal(conflict.status, 'conflict')
  assert.equal(f.getSubject(), 'Direct subject edit')
  if (conflict.status !== 'conflict') assert.fail('expected subject apply confirmation')
  const applied = await f.service.applySubject({
    ...request,
    confirmedCurrentVersion: conflict.currentVersion
  })
  assert.equal(applied.status, 'applied')
  assert.equal(f.getSubject(), 'AI subject')
  if (applied.status !== 'applied') assert.fail('expected subject apply id')
  assert.deepEqual(
    plain(
      await f.service.applySubject({
        ...request,
        confirmedCurrentVersion: conflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )

  f.setSubject('User subject edit before undo')
  const undoRequest = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId: applied.applyId
  }
  const undoConflict = await f.service.undoSubject(undoRequest)
  assert.equal(undoConflict.status, 'conflict')
  assert.equal(f.getSubject(), 'User subject edit before undo')
  if (undoConflict.status !== 'conflict') assert.fail('expected subject undo confirmation')
  f.setSubject('Newer subject edit')
  const refreshed = await f.service.undoSubject({
    ...undoRequest,
    confirmedCurrentVersion: undoConflict.currentVersion
  })
  assert.equal(refreshed.status, 'conflict')
  assert.equal(f.getSubject(), 'Newer subject edit')
  if (refreshed.status !== 'conflict') assert.fail('expected refreshed subject conflict')
  assert.deepEqual(
    plain(
      await f.service.undoSubject({
        ...undoRequest,
        confirmedCurrentVersion: undoConflict.currentVersion
      })
    ),
    { status: 'stale_target' }
  )
  const undone = await f.service.undoSubject({
    ...undoRequest,
    confirmedCurrentVersion: refreshed.currentVersion
  })
  assert.deepEqual(plain(undone), { status: 'undone' })
  assert.equal(f.getSubject(), 'Direct subject edit')
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
  const status = await f.service.getStatus()
  assert.equal(status.status, 'unsupported')
  if (status.status !== 'unsupported') assert.fail('unsupported compose should remain unavailable')
  assert.equal(status.candidates?.length, 1)
  assert.equal(status.candidates?.[0].lastUsedAt, 123)
  assert.deepEqual(plain(await f.service.getSnapshot()), {
    status: 'unsupported',
    code: 'unsupported_content',
    candidates: plain(status.candidates)
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
  const focusedChild = new SyntheticElement('span', editor)
  nodes.push(focusedChild)
  listeners.get('focusin')({ target: focusedChild })
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
  listeners.get('click')({ target: subject })
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

test('an empty unfocused compose is discovered beside an unrelated editor and keeps its target', () => {
  class SyntheticElement {
    constructor(selector = '', parentElement = null, text = '', placeholder = null) {
      this.selector = selector
      this.parentElement = parentElement
      this.innerText = text
      this.placeholder = placeholder
      this.value = ''
      this.isConnected = true
      this.childNodes = text.trim()
        ? [{ nodeType: 3, textContent: text }]
        : [{ nodeType: 1, nodeName: 'BR' }]
    }
    matches(selector) {
      return this.selector === selector
    }
    closest(selector) {
      return this.matches(selector) ? this : (this.parentElement?.closest(selector) ?? null)
    }
    getClientRects() {
      return [{ width: 120, height: 24 }]
    }
    querySelectorAll(selector) {
      if (selector === '[contenteditable="true"]')
        return this === composeRoot
          ? composeMounted
            ? [editor]
            : []
          : this === unrelatedRoot
            ? [unrelatedEditor]
            : []
      if (selector === 'input[name="subjectbox"]')
        return this === composeRoot && composeMounted ? [subject] : []
      if (selector === '[email], input[name="to"]') return []
      return []
    }
    querySelector() {
      return null
    }
    getAttribute(name) {
      if (name === 'aria-placeholder' || name === 'data-placeholder') return this.placeholder
      return null
    }
    replaceChildren(...nodes) {
      this.childNodes = nodes
      this.innerText = nodes.map((node) => node.textContent ?? '\n').join('')
    }
    dispatchEvent() {
      return true
    }
  }
  class SyntheticInput extends SyntheticElement {}
  const composeRoot = new SyntheticElement('compose-root')
  const editor = new SyntheticElement(
    '[contenteditable="true"]',
    composeRoot,
    ' \n ',
    'Message body'
  )
  const subject = new SyntheticInput('input[name="subjectbox"]', composeRoot)
  const unrelatedRoot = new SyntheticElement('search-root')
  const unrelatedEditor = new SyntheticElement('[contenteditable="true"]', unrelatedRoot, 'Search')
  const listeners = new Map()
  const observers = []
  const scheduled = []
  let composeMounted = false
  class SyntheticObserver {
    constructor(callback) {
      this.callback = callback
      observers.push(this)
    }
    observe(target, options) {
      this.target = target
      this.options = options
    }
    disconnect() {
      this.disconnected = true
    }
  }
  const context = {
    document: {
      documentElement: {},
      querySelectorAll: (selector) =>
        selector === '[contenteditable="true"]'
          ? composeMounted
            ? [unrelatedEditor, editor]
            : [unrelatedEditor]
          : [],
      addEventListener: (name, listener) => listeners.set(name, listener),
      removeEventListener: (name) => listeners.delete(name),
      createElement: (name) => ({ nodeType: 1, nodeName: name.toUpperCase() }),
      createTextNode: (textContent) => ({ nodeType: 3, textContent })
    },
    Element: SyntheticElement,
    HTMLInputElement: SyntheticInput,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    MutationObserver: SyntheticObserver,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay }
      scheduled.push(timer)
      return timer
    },
    clearTimeout: () => undefined,
    Event: class Event {
      constructor(_type, options) {
        this.bubbles = options?.bubbles === true
      }
    }
  }
  runInNewContext(gmailComposeTargetPageSource('synthetic-blank-compose'), context)
  assert.equal(context.__hantongComposeTarget.read().targetId, null)
  composeMounted = true
  observers[0].callback()
  assert.equal(scheduled[0].delay, 100)
  scheduled[0].callback()
  listeners.get('click')({ target: unrelatedEditor })
  const result = context.__hantongComposeTarget.read()
  assert.equal(result.targetId, 'target-1')
  assert.equal(result.snapshot.subject, '')
  assert.equal(result.snapshot.body, '')
  assert.equal(result.snapshot.supported, true)
  editor.innerText = 'First characters'
  editor.childNodes = [{ nodeType: 3, textContent: 'First characters' }]
  listeners.get('input')({ target: editor })
  const afterTyping = context.__hantongComposeTarget.read()
  assert.equal(afterTyping.targetId, result.targetId)
  assert.equal(afterTyping.snapshot.body, 'First characters')
  assert.deepEqual(
    plain(
      context.__hantongComposeTarget.replace(
        result.targetId,
        'First characters',
        'Only intended compose'
      )
    ),
    { status: 'applied' }
  )
  assert.equal(editor.innerText, 'Only intended compose')
  assert.equal(unrelatedEditor.innerText, 'Search')
  editor.innerText = 'x'.repeat(20_001)
  editor.childNodes = [{ nodeType: 3, textContent: editor.innerText }]
  const oversized = context.__hantongComposeTarget.read()
  assert.equal(oversized.snapshot.supported, false)
  assert.equal(oversized.snapshot.body, '')
  const metadata = context.__hantongComposeTarget.listTargets()[0]
  assert.equal(metadata.title, 'New message')
  assert.equal(Object.hasOwn(metadata, 'body'), false)
  editor.isConnected = false
  assert.equal(context.__hantongComposeTarget.read().targetId, null)
  assert.equal(
    context.__hantongComposeTarget.replace('target-1', '', 'Must not write').status,
    'stale_target'
  )
  context.__hantongComposeTarget.revoke()
})

test('initial compose activity is unknown and later same-batch opens tie until user focus', () => {
  const fixture = composeProbeFixture()
  fixture.addCompose('Initial A')
  fixture.addCompose('Initial B')
  const initial = fixture.probe.listTargets()
  assert.deepEqual(plain(initial.map(({ title, lastUsedAt }) => ({ title, lastUsedAt }))), [
    { title: 'Initial A', lastUsedAt: 0 },
    { title: 'Initial B', lastUsedAt: 0 }
  ])

  fixture.setNow(500)
  const laterA = fixture.addCompose('Opened A')
  fixture.addCompose('Opened B')
  fixture.discoverLater()
  const later = fixture.probe.listTargets().filter(({ title }) => title.startsWith('Opened'))
  assert.deepEqual(plain(later.map(({ title, lastUsedAt }) => ({ title, lastUsedAt }))), [
    { title: 'Opened A', lastUsedAt: 500 },
    { title: 'Opened B', lastUsedAt: 500 }
  ])

  fixture.setNow(750)
  fixture.focus(laterA.editor)
  assert.equal(
    fixture.probe.listTargets().find(({ title }) => title === 'Opened A').lastUsedAt,
    750
  )
  fixture.setNow(900)
  const laterBId = fixture.probe.listTargets().find(({ title }) => title === 'Opened B').targetId
  assert.equal(fixture.probe.selectTarget(laterBId), true)
  assert.equal(
    fixture.probe.listTargets().find(({ title }) => title === 'Opened B').lastUsedAt,
    500
  )
})

test('evicted and stale target IDs are harmless and do not hide remaining candidates', () => {
  const fixture = composeProbeFixture()
  const first = Array.from({ length: 32 }, (_, index) => fixture.addCompose(`Draft ${index + 1}`))
  const initial = fixture.probe.listTargets()
  const stale = initial.find(({ title }) => title === 'Draft 1')
  assert.ok(stale)
  fixture.setNow(400)
  fixture.focus(first[0].editor)
  assert.equal(fixture.probe.selectTarget(stale.targetId), true)

  fixture.setNow(600)
  fixture.addCompose('Draft 33')
  fixture.discoverLater()
  assert.equal(fixture.probe.readTarget(stale.targetId), null)
  const afterEviction = fixture.probe.listTargets()
  assert.equal(afterEviction.length, 32)
  assert.ok(afterEviction.some(({ title }) => title === 'Draft 33'))
  assert.equal(
    afterEviction.some(({ title }) => title === 'Draft 1'),
    false
  )
  const refreshed = fixture.probe.read()
  assert.equal(refreshed.targetId, null)
  assert.equal(refreshed.targets.length, 32)
  assert.ok(refreshed.targets.some(({ title }) => title === 'Draft 33'))

  fixture.setNow(800)
  fixture.focus(first[0].editor)
  const refocused = fixture.probe.listTargets().find(({ title }) => title === 'Draft 1')
  assert.ok(refocused)
  assert.notEqual(refocused.targetId, stale.targetId)
  assert.equal(refocused.lastUsedAt, 800)
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
  assert.deepEqual(plain(result), {
    targetId: null,
    snapshot: null,
    targets: [],
    discovery: {
      editorCount: 0,
      candidateCount: 0,
      rejectedNoMatch: 0,
      rejectedNotVisible: 0,
      capacityEvictions: 0
    }
  })
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
  const { registerMainIpc } = loadTypeScript(
    new URL('../src/main/ipc/main-ipc.ts', import.meta.url),
    {
      electron
    }
  )
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
  const { registerMainIpc } = loadTypeScript(
    new URL('../src/main/ipc/main-ipc.ts', import.meta.url),
    {
      electron
    }
  )
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
