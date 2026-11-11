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
          targetId: 'target-7',
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
      return selector.includes('Reply')
        ? selector.includes('aria-label')
          ? replyMarker
          : null
        : null
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
  const editor = new SyntheticElement('[contenteditable="true"]', root, 'Reply fixture body')
  const replyMarker = new SyntheticElement('[aria-label*="Reply"]', root)
  const nodes = [root, editor, replyMarker]
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
