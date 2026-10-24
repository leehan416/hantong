/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { firstId, fixture } from './helpers/account-view-fixture.mjs'

test('a successful Gmail document load restores identity readiness after a mainframe failure', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.loadingMainFrame = false
  webContents.emit('did-fail-load', {}, -105, 'network error', webContents.url, true)
  webContents.emit('did-frame-finish-load', {}, false)
  webContents.emit('did-stop-loading')
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  assert.equal(fixtureData.identityFailures.at(-1), 'view_not_loaded')

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://mail.google.com/mail/u/0/#inbox'
  webContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')

  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  await fixtureData.manager.dispose()
})

test('same-document navigation keeps a ready Gmail identity readable', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: true
  })
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  webContents.loadingMainFrame = true
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })
  assert.equal(fixtureData.identityFailures.at(-1), 'document_loading')
  await fixtureData.manager.dispose()
})

test('sign-in view stays attached while Google navigates between login pages', async () => {
  const fixtureData = fixture()
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents

  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/ServiceLogin'
  )
  webContents.url = 'https://accounts.google.com/ServiceLogin'
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: webContents.url
  })
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.emit('did-stop-loading')
  assert.equal(fixtureData.attached.length, 1)

  fixtureData.created[0].view.callbacks.onMainFrameNavigation(
    'https://accounts.google.com/v3/signin/challenge/pwd'
  )
  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: 'https://accounts.google.com/v3/signin/challenge/pwd'
  })

  assert.equal(fixtureData.detached.length, 0)
  assert.equal(fixtureData.attached.length, 1)
  await fixtureData.manager.dispose()
})

test('trusted sign-in DOM readiness ends the timeout while the main frame continues loading', async () => {
  const diagnostics = []
  const fixtureData = fixture({
    deferLoads: true,
    loadTimeoutMs: 5,
    onLoadDiagnostic: (...event) => diagnostics.push(event)
  })
  await fixtureData.manager.activate(firstId)
  const webContents = fixtureData.created[0].view.webContents
  const signInUrl = 'https://accounts.google.com/v3/signin/challenge/pwd'
  webContents.url = signInUrl
  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: signInUrl
  })
  webContents.emit('dom-ready')

  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'ready'
  })
  assert.deepEqual(structuredClone(fixtureData.manager.getDocumentState(firstId)), {
    revision: 1,
    kind: 'sign_in',
    ready: true
  })
  assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(fixtureData.statuses.at(-1).status, 'ready')
  assert.equal(
    diagnostics.some(([, event]) => event.type === 'load_timeout'),
    false
  )
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(fixtureData.statuses.at(-1).status, 'ready')
  await fixtureData.manager.dispose()
})

test('mail, untrusted, and stale sign-in DOM readiness cannot bypass the load gate', async () => {
  for (const target of [
    {
      name: 'mail',
      pendingUrl: 'https://mail.google.com/mail/u/0/',
      currentUrl: 'https://mail.google.com/mail/u/0/'
    },
    {
      name: 'untrusted redirect',
      pendingUrl: 'https://accounts.google.com/ServiceLogin',
      currentUrl: 'https://accounts.google.com.evil.test/ServiceLogin'
    },
    {
      name: 'stale sign-in DOM readiness during a pending mail navigation',
      pendingUrl: 'https://mail.google.com/mail/u/0/',
      currentUrl: 'https://accounts.google.com/ServiceLogin'
    }
  ]) {
    const fixtureData = fixture({ deferLoads: true, loadTimeoutMs: 5 })
    await fixtureData.manager.activate(firstId)
    const webContents = fixtureData.created[0].view.webContents
    webContents.url = target.currentUrl
    webContents.loadingMainFrame = true
    webContents.emit('did-start-navigation', {
      isMainFrame: true,
      isSameDocument: false,
      url: target.pendingUrl
    })
    webContents.emit('dom-ready')
    assert.equal(fixtureData.statuses.at(-1).status, 'loading', target.name)
    await new Promise((resolve) => setTimeout(resolve, 15))
    assert.equal(fixtureData.statuses.at(-1).status, 'error', target.name)
    assert.equal(fixtureData.manager.getDocumentState(firstId).ready, false, target.name)
    assert.equal(fixtureData.manager.setMailAccess(firstId, true, 1), false, target.name)
    await fixtureData.manager.dispose()
  }

  const staleFixture = fixture({ deferLoads: true, loadTimeoutMs: 1000 })
  await staleFixture.manager.activate(firstId)
  const staleContents = staleFixture.created[0].view.webContents
  staleContents.url = 'https://accounts.google.com/ServiceLogin'
  staleContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false,
    url: staleContents.url
  })
  const statusCount = staleFixture.statuses.length
  await staleFixture.manager.dispose()
  staleContents.emit('dom-ready')
  assert.equal(staleFixture.statuses.length, statusCount)
})

test('a closed owner suppresses stale load completion callbacks', async () => {
  const fixtureData = fixture({ deferLoads: true })
  await fixtureData.manager.activate(firstId)
  const reportedBeforeClose = fixtureData.statuses.length
  fixtureData.window.isDestroyed = () => true
  await fixtureData.manager.dispose()
  fixtureData.resolvers[0]()
  await Promise.resolve()
  assert.equal(fixtureData.statuses.length, reportedBeforeClose)
})

test('renderer crash invalidates an in-flight load before its late success', async () => {
  const diagnostics = []
  const fixtureData = fixture({
    deferLoads: true,
    onLoadDiagnostic: (...event) => diagnostics.push(event)
  })
  await fixtureData.manager.activate(firstId)
  const webContents = fixtureData.created[0].view.webContents
  webContents.emit('render-process-gone')
  assert.deepEqual(structuredClone(diagnostics), [
    [firstId, { type: 'process_gone', reason: 'unknown' }]
  ])
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  webContents.emit('did-frame-finish-load', {}, true)
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: null
  })

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.deepEqual(structuredClone(await fixtureData.manager.readWebIdentity(firstId)), {
    accountExists: true,
    emailAddress: 'private@example.com'
  })
  await fixtureData.manager.dispose()
})

test('view load diagnostics include an uncommitted main-frame failure but skip subframes and aborts', async () => {
  const diagnostics = []
  const fixtureData = fixture({
    onLoadDiagnostic: (...event) => diagnostics.push(event)
  })
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const webContents = fixtureData.created[0].view.webContents
  webContents.loadingMainFrame = true
  webContents.emit('did-fail-load', {}, -105, 'private error', 'https://mail.google.com/new', false)
  webContents.emit('did-fail-load', {}, -3, 'aborted', 'https://mail.google.com/new', true)
  webContents.emit('did-fail-load', {}, -105, 'private error', 'https://mail.google.com/new', true)
  assert.deepEqual(structuredClone(diagnostics), [
    [firstId, { type: 'load_failure', errorCode: -105 }]
  ])
  await fixtureData.manager.dispose()
})

test('view timeout diagnostics preserve the load state and omit raw failure data', async () => {
  const diagnostics = []
  const fixtureData = fixture({
    deferLoads: true,
    loadTimeoutMs: 5,
    onLoadDiagnostic: (...event) => diagnostics.push(event)
  })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(structuredClone(diagnostics), [[firstId, { type: 'load_timeout' }]])
  assert.equal(fixtureData.statuses.at(-1).status, 'error')
  await fixtureData.manager.dispose()
})

test('diagnostic callback failures cannot interrupt view failure cleanup', async () => {
  const fixtureData = fixture({
    deferLoads: true,
    loadTimeoutMs: 5,
    onLoadDiagnostic: () => {
      throw new Error('private diagnostic sink failure')
    }
  })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(fixtureData.statuses.at(-1).status, 'error')
  await fixtureData.manager.dispose()
})

test('blocked navigation clears only after a successful trusted Gmail document load', async () => {
  const fixtureData = fixture()
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  const handle = fixtureData.created[0]
  const webContents = handle.view.webContents
  handle.view.callbacks.onNavigationBlocked()
  assert.equal(
    await fixtureData.manager.readWebIdentity(firstId).then((value) => value?.emailAddress),
    null
  )

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://accounts.google.com/signin'
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.equal(fixtureData.identityFailures.at(-1), 'view_blocked')
  assert.equal(fixtureData.statuses.at(-1).status, 'blocked')

  webContents.loadingMainFrame = true
  webContents.emit('did-start-navigation', {
    isMainFrame: true,
    isSameDocument: false
  })
  webContents.url = 'https://mail.google.com/mail/u/0/#inbox'
  webContents.emit('did-frame-finish-load', {}, true)
  webContents.loadingMainFrame = false
  webContents.emit('did-stop-loading')
  assert.equal(
    await fixtureData.manager.readWebIdentity(firstId).then((value) => value?.emailAddress),
    'private@example.com'
  )
  await fixtureData.manager.dispose()
})

test('manager forwards blocked navigation diagnostics with account identity', async () => {
  const diagnostics = []
  const fixtureData = fixture({ onNavigationDiagnostic: (...event) => diagnostics.push(event) })
  fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setImmediate(resolve))
  fixtureData.created[0].view.callbacks.onNavigationBlocked({
    source: 'redirect',
    context: 'main',
    hostname: 'login.school.example.edu',
    route: 'other',
    reason: 'external_redirect'
  })
  assert.equal(diagnostics[0][0], firstId)
  assert.equal(diagnostics[0][1].source, 'redirect')
  assert.deepEqual(diagnostics[0][1], {
    source: 'redirect',
    context: 'main',
    hostname: 'login.school.example.edu',
    route: 'other',
    reason: 'external_redirect'
  })
  await fixtureData.manager.dispose()
})

test('load timeout reports an error and a late success cannot replace it', async () => {
  const fixtureData = fixture({ deferLoads: true, loadTimeoutMs: 5 })
  await fixtureData.manager.activate(firstId)
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  fixtureData.resolvers[0]()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(fixtureData.statuses.at(-1)), {
    accountId: firstId,
    status: 'error'
  })
  await fixtureData.manager.dispose()
})
