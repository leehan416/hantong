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
  const headers =
    anchors.length === 0
      ? []
      : [
          {
            closest: () => null,
            querySelectorAll: (selector) => {
              assert.equal(selector, 'a[href]')
              return anchors
            }
          }
        ]
  const document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, 'header, [role="banner"]')
      return headers
    }
  }
  return runInNewContext(identity.GMAIL_ACCOUNT_IDENTITY_SCRIPT, { document, URL })
}

function executeHeader(headers) {
  const document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, 'header, [role="banner"]')
      return headers
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
    '__hantong_identity_failure__:identity_ambiguous'
  )
  assert.equal(
    executeDocument([
      anchor('https://accounts.google.com/SignOutOptions', 'a@example.com', 'MAIN')
    ]),
    '__hantong_identity_failure__:account_link_missing'
  )
  assert.equal(
    executeDocument([anchor('https://accounts.google.com/SignOutOptions', '(a!b@example.com)')]),
    'a!b@example.com'
  )
  assert.equal(
    executeDocument([anchor('https://accounts.google.com/SignOutOptions', 'bad:a!b@example.com')]),
    '__hantong_identity_failure__:account_email_unavailable'
  )
  assert.equal(
    executeDocument([
      anchor('https://accounts.google.com.evil.test/SignOutOptions', 'a@example.com')
    ]),
    '__hantong_identity_failure__:account_link_missing'
  )
})

test('identity script returns only fixed reasons for missing trusted account evidence', () => {
  const header = (anchors) => ({
    closest: () => null,
    querySelectorAll: () => anchors
  })
  assert.equal(executeHeader([]), '__hantong_identity_failure__:header_missing')
  assert.equal(
    executeHeader([header([anchor('https://accounts.google.com/SignOutOptions', null)])]),
    '__hantong_identity_failure__:account_label_missing'
  )
  assert.equal(
    executeHeader([header([anchor('https://accounts.google.com/SignOutOptions', 'Account')])]),
    '__hantong_identity_failure__:account_email_unavailable'
  )
})

test('identity reader reports fixed extraction reasons while remaining fail-closed', async () => {
  const reasons = []
  const view = {
    contents: makeContents({
      executeJavaScriptInIsolatedWorld: async () =>
        '__hantong_identity_failure__:account_email_unavailable'
    }),
    revision: () => 1,
    eligible: () => true
  }
  const reader = identity.createGoogleWebIdentityReader(
    () => view,
    (reason, id) => reasons.push([reason, id])
  )
  assert.equal(await reader.read(accountId), null)
  assert.deepEqual(reasons, [['account_email_unavailable', accountId]])
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

test('identity reader reports fixed failure reasons without changing fail-closed results', async () => {
  const reasons = []
  let view
  const reader = identity.createGoogleWebIdentityReader(
    () => view,
    (reason, id) => reasons.push([reason, id])
  )
  assert.equal(await reader.read(accountId), null)
  view = {
    contents: makeContents({ getURL: () => 'https://mail.google.com.evil.test/mail/u/0/' }),
    revision: () => 1,
    eligible: () => true
  }
  assert.equal(await reader.read(accountId), null)
  view = {
    contents: makeContents({ isLoadingMainFrame: () => true }),
    revision: () => 1,
    eligible: () => true
  }
  assert.equal(await reader.read(accountId), null)
  view = {
    contents: makeContents({ executeJavaScriptInIsolatedWorld: async () => 'a@example.com' }),
    revision: () => 1,
    eligible: () => true
  }
  view.contents.executeJavaScriptInIsolatedWorld = async () => {
    throw new Error('private DOM failure')
  }
  assert.equal(await reader.read(accountId), null)
  view.contents.executeJavaScriptInIsolatedWorld = async () => null
  assert.equal(await reader.read(accountId), null)
  assert.deepEqual(reasons, [
    ['missing_view', accountId],
    ['untrusted_document', accountId],
    ['document_loading', accountId],
    ['script_failed', accountId],
    ['identity_unavailable', accountId]
  ])

  const observerFailure = identity.createGoogleWebIdentityReader(
    () => undefined,
    () => {
      throw new Error('observer failure')
    }
  )
  assert.equal(await observerFailure.read(accountId), null)
})

test('identity reader reports navigation changes and keeps cancellation silent', async () => {
  const reasons = []
  const contents = makeContents()
  const view = {
    contents: {
      getURL: contents.getURL,
      isDestroyed: contents.isDestroyed,
      isLoadingMainFrame: contents.isLoadingMainFrame,
      executeJavaScriptInIsolatedWorld: async () => {
        contents.setRevision(4)
        return 'a@example.com'
      }
    },
    revision: contents.revision,
    eligible: () => contents.eligible()
  }
  const reader = identity.createGoogleWebIdentityReader(
    () => view,
    (reason) => reasons.push(reason)
  )
  assert.equal(await reader.read(accountId), null)
  const aborted = new AbortController()
  aborted.abort()
  assert.equal(await reader.read(accountId, aborted.signal), null)
  assert.deepEqual(reasons, ['navigation_changed'])
})
