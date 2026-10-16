/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const identity = loadTypeScript(new URL('../src/main/google-web-identity.ts', import.meta.url))
const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'

function anchor(href, label, parentName = 'HEADER') {
  return {
    href,
    getAttribute: (name) => (name === 'aria-label' ? label : null),
    closest: (selector) =>
      selector === 'main,[role="main"],[role="dialog"]' && parentName === 'MAIN' ? {} : null,
    parentName
  }
}

function executeDocument(anchors) {
  const document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, 'header a[href], [role="banner"] a[href]')
      return anchors
    }
  }
  return runInNewContext(identity.GMAIL_ACCOUNT_IDENTITY_SCRIPT, { document, URL })
}

function makeContents(overrides = {}) {
  let url = 'https://mail.google.com/mail/u/0/#inbox'
  let revision = 3
  let destroyed = false
  let loading = false
  let eligible = true
  let extracted = 'a@example.com'
  return {
    getURL: () => url,
    isDestroyed: () => destroyed,
    isLoadingMainFrame: () => loading,
    eligible: () => eligible,
    revision: () => revision,
    execute: async () => extracted,
    setUrl: (value) => (url = value),
    setRevision: (value) => (revision = value),
    setDestroyed: (value) => (destroyed = value),
    setLoading: (value) => (loading = value),
    setEligible: (value) => (eligible = value),
    setExtracted: (value) => (extracted = value),
    ...overrides
  }
}

test('identity script reads one email from account header evidence only', () => {
  const result = executeDocument([
    anchor(
      'https://accounts.google.com/SignOutOptions?hl=en',
      'Google Account: Owner <Owner@Example.com>'
    )
  ])
  assert.equal(result, 'owner@example.com')
})

test('identity script rejects ambiguous, malformed, and content-only evidence', () => {
  assert.equal(
    executeDocument([
      anchor('https://accounts.google.com/SignOutOptions', 'a@example.com'),
      anchor('https://accounts.google.com/SignOutOptions', 'b@example.com')
    ]),
    null
  )
  assert.equal(
    executeDocument([
      anchor('https://accounts.google.com/SignOutOptions', 'a@example.com', 'MAIN')
    ]),
    null
  )
  assert.equal(
    executeDocument([anchor('https://accounts.google.com/SignOutOptions', '(a!b@example.com)')]),
    'a!b@example.com'
  )
  assert.equal(
    executeDocument([anchor('https://accounts.google.com/SignOutOptions', 'bad:a!b@example.com')]),
    null
  )
  assert.equal(
    executeDocument([
      anchor('https://accounts.google.com.evil.test/SignOutOptions', 'a@example.com')
    ]),
    null
  )
})

test('reader rejects unsafe URL, load, disposal, malformed result, and navigation races', async () => {
  const contents = makeContents()
  let replaced = false
  const webViewContents = {
    getURL: contents.getURL,
    isDestroyed: contents.isDestroyed,
    isLoadingMainFrame: contents.isLoadingMainFrame,
    executeJavaScriptInIsolatedWorld: contents.execute
  }
  const webView = {
    contents: webViewContents,
    revision: contents.revision,
    eligible: () => contents.eligible()
  }
  const reader = identity.createGoogleWebIdentityReader(() =>
    replaced ? { ...webView, contents: { ...webViewContents } } : webView
  )
  assert.deepEqual(
    { ...(await reader.read(accountId)) },
    { accountExists: true, emailAddress: 'a@example.com' }
  )
  contents.setUrl('https://mail.google.com.evil.test/mail/u/0/')
  assert.equal(await reader.read(accountId), null)
  contents.setUrl('https://mail.google.com/mail/u/0/')
  contents.setLoading(true)
  assert.equal(await reader.read(accountId), null)
  contents.setLoading(false)
  contents.setEligible(false)
  assert.equal(await reader.read(accountId), null)
  contents.setEligible(true)
  contents.setExtracted({ email: 'a@example.com' })
  assert.equal(await reader.read(accountId), null)
  contents.setExtracted('x'.repeat(1025))
  assert.equal(await reader.read(accountId), null)
  contents.setExtracted('a@example.com')
  webViewContents.executeJavaScriptInIsolatedWorld = async () => {
    contents.setRevision(4)
    return 'a@example.com'
  }
  assert.equal(await reader.read(accountId), null)
  contents.setRevision(4)
  webViewContents.executeJavaScriptInIsolatedWorld = async () => {
    replaced = true
    return 'a@example.com'
  }
  assert.equal(await reader.read(accountId), null)
  contents.setDestroyed(true)
  assert.equal(await reader.read(accountId), null)
  contents.setDestroyed(false)
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await reader.read(accountId, aborted.signal), null)
})
