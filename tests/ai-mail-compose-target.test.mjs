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
      if (code.includes('globalThis.__hantongComposeTarget?.documentId ===')) {
        if (options.deferRead) await options.deferRead()
        return {
          targetId,
          snapshot: {
            subject: 'Synthetic subject',
            recipients: ['recipient@example.test'],
            body: 'Synthetic body',
            supported: true
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
    removeEventListener: (name) => listeners.delete(name)
  }
  const context = {
    document,
    Element: SyntheticElement,
    HTMLInputElement: class extends SyntheticElement {}
  }
  const source = gmailComposeTargetPageSource('synthetic-document-version')
  runInNewContext(source, context)
  listeners.get('click')({ target: editor })
  const result = context.__hantongComposeTarget.read()
  assert.equal(result.targetId, 'target-1')
  assert.equal(result.snapshot.subject, '')
  assert.equal(result.snapshot.body, 'Reply fixture body')
  assert.equal(result.snapshot.supported, true)
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
