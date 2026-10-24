/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const identity = loadTypeScript(new URL('../src/main/google-web-identity.ts', import.meta.url))
const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'

function makeView(overrides = {}) {
  const state = {
    url: 'https://mail.google.com/mail/u/0/#inbox',
    title: 'Inbox (3) - a@example.com - Gmail',
    destroyed: false,
    loading: false,
    eligible: true
  }
  return {
    state,
    view: {
      contents: {
        getURL: () => state.url,
        getTitle: () => state.title,
        isDestroyed: () => state.destroyed,
        isLoadingMainFrame: () => state.loading,
        ...overrides
      },
      revision: () => 1,
      eligible: () => state.eligible
    }
  }
}

test('title parser reads the account email for any domain', () => {
  assert.equal(
    identity.emailFromGmailTitle('Inbox (3) - Owner@Example.com - Gmail'),
    'owner@example.com'
  )
  assert.equal(
    identity.emailFromGmailTitle('받은편지함 - student@school.ac.kr - 학교 Mail'),
    'student@school.ac.kr'
  )
  assert.equal(
    identity.emailFromGmailTitle('Inbox - me@university.edu - Gmail'),
    'me@university.edu'
  )
})

test('title parser keeps the account email when a subject contains another address', () => {
  assert.equal(
    identity.emailFromGmailTitle('Re: other@evil.test - owner@example.com - Gmail'),
    'owner@example.com'
  )
  assert.equal(
    identity.emailFromGmailTitle('other@evil.test - owner@example.com - Gmail'),
    'owner@example.com'
  )
})

test('title parser trusts only the account position and fails closed otherwise', () => {
  for (const title of [
    'Gmail',
    'Loading…',
    '',
    'Inbox - Gmail',
    'owner@example.com',
    'a@b - Gmail',
    'Fwd - victim@example.com - Chat - Gmail',
    'Inbox - me@university.edu - Org - Name Mail',
    `Inbox - ${'a'.repeat(65)}@example.com - Gmail`,
    `Inbox - a@${'b'.repeat(250)}.com - Gmail`,
    'Inbox - a\u0000b@example.com - Gmail',
    'Inbox - a@ex\u202eample.com - Gmail'
  ])
    assert.equal(identity.emailFromGmailTitle(title), null, title)
})

test('reader returns the title email from a trusted, loaded Gmail document', async () => {
  const { view } = makeView()
  const reader = identity.createGoogleWebIdentityReader(() => view)
  assert.deepEqual(
    { ...(await reader.read(accountId)) },
    { accountExists: true, emailAddress: 'a@example.com' }
  )
})

test('reader rejects unsafe URL, load, disposal, ineligible view, and cancellation', async () => {
  const { state, view } = makeView()
  const reader = identity.createGoogleWebIdentityReader(() => view)
  state.url = 'https://mail.google.com.evil.test/mail/u/0/'
  assert.equal(await reader.read(accountId), null)
  state.url = 'https://mail.google.com/mail/u/0/'
  state.loading = true
  assert.equal(await reader.read(accountId), null)
  state.loading = false
  state.eligible = false
  assert.equal(await reader.read(accountId), null)
  state.eligible = true
  state.destroyed = true
  assert.equal(await reader.read(accountId), null)
  state.destroyed = false
  state.title = 'Gmail'
  assert.equal(await reader.read(accountId), null)
  state.title = 'Inbox - a@example.com - Gmail'
  assert.equal(await reader.read('not-an-account-id'), null)
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
  view = makeView({ getURL: () => 'https://mail.google.com.evil.test/mail/u/0/' }).view
  assert.equal(await reader.read(accountId), null)
  view = makeView({ isLoadingMainFrame: () => true }).view
  assert.equal(await reader.read(accountId), null)
  view = makeView({ getTitle: () => 'Gmail' }).view
  assert.equal(await reader.read(accountId), null)
  assert.deepEqual(reasons, [
    ['missing_view', accountId],
    ['untrusted_document', accountId],
    ['document_loading', accountId],
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
