/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these JavaScript test doubles without a TypeScript loader. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

function fixture({
  allowed = false,
  rejectOpenExternal = false,
  development = false,
  enableLogoutProbe,
  throwProbeReporter = false,
  acceptLogoutTerminalRedirect = false,
  throwTerminalRedirect = false
} = {}) {
  const opened = []
  let blocked = 0
  const diagnostics = []
  const logoutSignals = []
  let terminalRedirectSignals = 0
  const recordsForProbe = []
  const webRequest = new EventEmitter()
  const registeredListeners = new Map()
  const install = (event, listener) => {
    if (listener) {
      registeredListeners.set(event, listener)
      webRequest.on(event, listener)
    } else webRequest.removeAllListeners(event)
  }
  webRequest.onBeforeRequest = (filter, listener) => install('before-request', listener)
  webRequest.onBeforeRedirect = (filter, listener) => install('before-redirect', listener)
  webRequest.onCompleted = (filter, listener) => install('completed', listener)
  webRequest.onErrorOccurred = (filter, listener) => install('error-occurred', listener)
  let reloads = 0
  const webSession = {
    setPermissionCheckHandler(handler) {
      this.checkPermission = handler
    },
    setPermissionRequestHandler(handler) {
      this.requestPermission = handler
    },
    webRequest
  }
  class Contents extends EventEmitter {
    id = 15
    destroyed = false
    loads = []
    setWindowOpenHandler(handler) {
      this.openWindow = handler
    }
    async loadURL(url) {
      this.loads.push(url)
    }
    reload() {
      reloads += 1
    }
    isDestroyed() {
      return this.destroyed
    }
    close() {
      this.destroyed = true
      this.emit('destroyed')
    }
  }
  class View {
    constructor(options) {
      this.options = options
      this.webContents = new Contents()
    }
  }
  const { createGmailView } = loadTypeScript(
    new URL('../src/main/gmail-view.ts', import.meta.url),
    {
      electron: { WebContentsView: View, app: { isPackaged: !development } }
    }
  )
  const handle = createGmailView(
    webSession,
    {
      openExternal: async (url) => {
        opened.push(url)
        if (rejectOpenExternal) throw new Error('private launch failure')
      },
      onNavigationBlocked: (diagnostic) => {
        blocked += 1
        diagnostics.push(diagnostic)
      },
      onMainFrameNavigation: (url) => navigated.push(url),
      onLogoutRequestStart: (requestId) => (logoutSignals.push(['start', requestId]), 'accepted'),
      onLogoutRequestSuccess: (requestId) => (
        logoutSignals.push(['success', requestId]),
        'waiting_for_ready_sign_in'
      ),
      onLogoutRequestFailure: (requestId) => logoutSignals.push(['failure', requestId]),
      onLogoutTerminalRedirect: () => {
        terminalRedirectSignals += 1
        if (throwTerminalRedirect) throw new Error('private logout observer failure')
        return acceptLogoutTerminalRedirect
      },
      isMailAccessAllowed: () => allowed
    },
    {
      enableLogoutProbe,
      reportLogoutProbe: (record) => {
        if (throwProbeReporter) throw new Error('private observer failure')
        recordsForProbe.push(record)
      }
    }
  )
  const navigated = []
  return {
    handle,
    webSession,
    opened,
    blocked: () => blocked,
    diagnostics,
    logoutSignals,
    terminalRedirectSignals: () => terminalRedirectSignals,
    recordsForProbe,
    registeredListeners,
    webRequest,
    navigated,
    reloads: () => reloads
  }
}

test('creating a Gmail view grants no Node or preload access and does not load eagerly', async () => {
  const { handle, webSession } = fixture()
  const preferences = handle.view.options.webPreferences
  assert.equal(preferences.session, webSession)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.nodeIntegrationInSubFrames, false)
  assert.equal(preferences.webSecurity, true)
  assert.equal(preferences.webviewTag, false)
  assert.equal(preferences.preload, undefined)
  assert.equal(handle.view.webContents.loads.length, 0)
  await handle.load()
  assert.deepEqual(handle.view.webContents.loads, ['https://mail.google.com/'])
})

test('dev logout probe reports fixed route events without retaining request data', async () => {
  const { handle, webRequest, recordsForProbe } = fixture({ development: true })
  const details = {
    id: 47,
    url: 'https://accounts.google.com/Logout?continue=https%3A%2F%2Fmail.google.com%2F&email=private%40example.com#secret',
    resourceType: 'mainFrame',
    statusCode: 302,
    redirectURL: 'https://mail.google.com/mail/u/0/?email=private%40example.com',
    error: 'private network error'
  }
  let continued = false
  webRequest.emit('before-request', details, (result) => {
    continued = true
    assert.equal(Object.keys(result).length, 0)
  })
  webRequest.emit('before-redirect', details)
  webRequest.emit('completed', details)
  webRequest.emit('error-occurred', details)
  assert.equal(continued, true)
  assert.deepEqual(
    recordsForProbe.map((record) => record.event),
    ['start', 'redirect', 'completed', 'error']
  )
  assert.equal(recordsForProbe[0].route, 'accounts_logout_candidate_unverified')
  assert.equal(recordsForProbe[1].statusCode, 302)
  assert.equal(recordsForProbe[1].redirectTarget, 'gmail')
  assert.equal(recordsForProbe[2].requestId, 47)
  const output = JSON.stringify(recordsForProbe)
  for (const privateValue of ['continue=', 'email=', 'private', 'secret', 'network error']) {
    assert.equal(output.includes(privateValue), false)
  }
  assert.equal(webRequest.listenerCount('before-request'), 1)
  await handle.dispose()
  assert.equal(webRequest.listenerCount('before-request'), 0)
  assert.equal(webRequest.listenerCount('before-redirect'), 0)
  assert.equal(webRequest.listenerCount('completed'), 0)
  assert.equal(webRequest.listenerCount('error-occurred'), 0)
})

test('logout probe ignores spoofed candidate URLs and can be disabled', () => {
  const { handle, webRequest, recordsForProbe } = fixture({ development: true })
  assert.equal(webRequest.listenerCount('before-request'), 1)
  webRequest.emit('completed', {
    id: 1,
    url: 'https://accounts.google.com.evil.test/Logout',
    statusCode: 200,
    resourceType: 'mainFrame'
  })
  webRequest.emit('completed', {
    id: 2,
    url: 'https://accounts.google.com:444/Logout',
    statusCode: 200,
    resourceType: 'mainFrame'
  })
  webRequest.emit('completed', {
    id: 3,
    url: 'https://mail.google.com/mail/logout?email=private%40example.com',
    statusCode: 200,
    resourceType: 'mainFrame'
  })
  assert.deepEqual(
    recordsForProbe.map((record) => record.route),
    ['mail_logout_candidate_unverified']
  )
  const optOut = fixture({ development: true, enableLogoutProbe: false })
  assert.equal(optOut.webRequest.listenerCount('before-request'), 1)
  const packaged = fixture({ enableLogoutProbe: true })
  assert.equal(packaged.webRequest.listenerCount('before-request'), 1)
  void handle.dispose()
  void optOut.handle.dispose()
  void packaged.handle.dispose()
})

test('production logout signal requires this view main frame and a matching successful response', async () => {
  const { handle, webRequest, logoutSignals } = fixture()
  const base = {
    id: 51,
    url: 'https://accounts.google.com/Logout?continue=private',
    webContentsId: 15,
    resourceType: 'mainFrame'
  }
  const starts = []
  const start = (details) =>
    webRequest.emit('before-request', details, () => starts.push(details.id))
  start({ ...base, webContentsId: 99 })
  start({ ...base, id: 52, resourceType: 'subFrame' })
  start({ ...base, id: 53, url: 'https://accounts.google.com.evil.test/Logout' })
  start(base)
  webRequest.emit('completed', { ...base, statusCode: 500 })
  start({ ...base, id: 54 })
  webRequest.emit('completed', { ...base, id: 54, statusCode: 200 })
  assert.deepEqual(logoutSignals, [
    ['start', 51],
    ['failure', 51],
    ['start', 54],
    ['success', 54]
  ])
  assert.deepEqual(starts, [51, 52, 53, 51, 54])
  await handle.dispose()
})

test('development logout probe identifies owning context without logging request URLs', async () => {
  const { handle, webRequest, recordsForProbe, logoutSignals } = fixture({ development: true })
  class Child extends EventEmitter {
    webContents = new handle.view.webContents.constructor()
    destroyed = false
    isDestroyed() {
      return this.destroyed
    }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.webContents.close()
    }
  }
  const child = new Child()
  child.webContents.id = 99
  handle.view.webContents.emit('did-create-window', child, { url: 'https://accounts.google.com/' })
  const request = (id, webContentsId) => ({
    id,
    url: 'https://accounts.google.com/Logout?email=private%40example.com',
    webContentsId,
    resourceType: 'mainFrame'
  })
  const start = (details) => webRequest.emit('before-request', details, () => undefined)
  start(request(61, handle.view.webContents.id))
  start(request(62, child.webContents.id))
  webRequest.emit('completed', { ...request(62, child.webContents.id), statusCode: 200 })
  webRequest.emit('completed', {
    ...request(61, handle.view.webContents.id),
    statusCode: 200
  })
  start(request(64, handle.view.webContents.id))
  webRequest.emit('completed', { ...request(64, child.webContents.id), statusCode: 200 })
  assert.deepEqual(
    recordsForProbe.map(({ event, requestId, ownerContext, decision }) => ({
      event,
      requestId,
      ownerContext,
      decision
    })),
    [
      { event: 'start', requestId: 61, ownerContext: 'view_main', decision: 'accepted' },
      { event: 'start', requestId: 62, ownerContext: 'popup', decision: 'not_owner_main_frame' },
      { event: 'completed', requestId: 62, ownerContext: 'popup', decision: 'untracked' },
      {
        event: 'completed',
        requestId: 61,
        ownerContext: 'view_main',
        decision: 'waiting_for_ready_sign_in'
      },
      {
        event: 'start',
        requestId: 64,
        ownerContext: 'view_main',
        decision: 'accepted'
      },
      {
        event: 'completed',
        requestId: 64,
        ownerContext: 'popup',
        decision: 'not_owner_main_frame'
      }
    ]
  )
  assert.deepEqual(logoutSignals, [
    ['start', 61],
    ['success', 61],
    ['start', 64]
  ])
  const output = JSON.stringify(recordsForProbe)
  assert.equal(output.includes('private'), false)
  assert.equal(output.includes('email='), false)
  await handle.dispose()
})

test('tracked main-frame response is accepted when completion omits optional owner metadata', async () => {
  const { handle, webRequest, logoutSignals, recordsForProbe } = fixture({ development: true })
  const request = {
    id: 63,
    url: 'https://accounts.google.com/Logout',
    webContentsId: handle.view.webContents.id,
    resourceType: 'mainFrame'
  }
  webRequest.emit('before-request', request, () => undefined)
  webRequest.emit('completed', {
    id: request.id,
    url: request.url,
    resourceType: 'mainFrame',
    statusCode: 200
  })
  assert.deepEqual(logoutSignals, [
    ['start', request.id],
    ['success', request.id]
  ])
  assert.deepEqual(
    recordsForProbe.map(({ event, ownerContext, decision, observed }) => ({
      event,
      ownerContext,
      decision,
      ...(observed === undefined ? {} : { observed })
    })),
    [
      { event: 'start', ownerContext: 'view_main', decision: 'accepted' },
      {
        event: 'completed',
        ownerContext: 'other',
        decision: 'waiting_for_ready_sign_in',
        observed: true
      }
    ]
  )
  await handle.dispose()
})

test('logout probe observer errors do not block requests and stale callbacks are inert', async () => {
  const { handle, webRequest, recordsForProbe, registeredListeners } = fixture({
    development: true
  })
  let continued = false
  webRequest.emit(
    'before-request',
    {
      id: 5,
      url: 'https://accounts.google.com/Logout',
      resourceType: 'mainFrame'
    },
    () => {
      continued = true
    }
  )
  assert.equal(continued, true)
  const staleStart = registeredListeners.get('before-request')
  await handle.dispose()
  assert.equal(webRequest.listenerCount('before-request'), 0)
  assert.equal(recordsForProbe.length, 1)
  let staleContinued = false
  staleStart(
    { id: 6, url: 'https://accounts.google.com/Logout', resourceType: 'mainFrame' },
    () => {
      staleContinued = true
    }
  )
  assert.equal(staleContinued, true)
  assert.equal(recordsForProbe.length, 1)
  const throwing = fixture({ development: true, throwProbeReporter: true })
  let throwingContinued = false
  throwing.webRequest.emit(
    'before-request',
    { id: 7, url: 'https://accounts.google.com/Logout', resourceType: 'mainFrame' },
    () => {
      throwingContinued = true
    }
  )
  assert.equal(throwingContinued, true)
  void throwing.handle.dispose()
})

test('both permission paths deny external content access', () => {
  const { webSession } = fixture()
  assert.equal(webSession.checkPermission(null, 'media', 'https://mail.google.com'), false)
  let granted
  webSession.requestPermission(null, 'notifications', (value) => {
    granted = value
  })
  assert.equal(granted, false)
})

test('external navigation is cancelled and opened outside the Gmail session', () => {
  const { handle, opened } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-frame-navigate', {
    url: 'https://example.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.deepEqual(opened, ['https://example.com/'])
})

test('redirects cannot launch the system browser or leave the trusted hosts', () => {
  const { handle, opened, blocked } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://example.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.deepEqual(opened, [])
  assert.equal(blocked(), 1)
})

test('school SSO redirect reports only its validated hostname and fixed classification', () => {
  const { handle, diagnostics } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://login.school.example.edu/sso/private?email=a%40b.test#secret',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.deepEqual(structuredClone(diagnostics[0]), {
    source: 'redirect',
    context: 'main',
    hostname: 'login.school.example.edu',
    route: 'other',
    reason: 'external_redirect'
  })
})

test('workspace redirect remains blocked and suppresses the generic block only for accepted logout evidence', () => {
  const unrelated = fixture()
  let prevented = false
  unrelated.handle.view.webContents.emit('will-redirect', {
    url: 'https://workspace.google.com/chooseaccount?private=1',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(unrelated.terminalRedirectSignals(), 1)
  assert.equal(unrelated.blocked(), 1)

  const logout = fixture({ acceptLogoutTerminalRedirect: true })
  prevented = false
  logout.handle.view.webContents.emit('will-redirect', {
    url: 'https://workspace.google.com/chooseaccount?private=1',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(logout.terminalRedirectSignals(), 1)
  assert.equal(logout.blocked(), 0)
  assert.deepEqual(logout.opened, [])
})

test('workspace redirect signal rejects spoofed or non-default HTTPS destinations', () => {
  const { handle, terminalRedirectSignals, blocked } = fixture({
    acceptLogoutTerminalRedirect: true
  })
  for (const url of [
    'https://workspace.google.com.evil.test/',
    'https://workspace.google.com:444/',
    'http://workspace.google.com/',
    'https://user@workspace.google.com/'
  ]) {
    let prevented = false
    handle.view.webContents.emit('will-redirect', {
      url,
      isMainFrame: true,
      preventDefault() {
        prevented = true
      }
    })
    assert.equal(prevented, true)
  }
  assert.equal(terminalRedirectSignals(), 0)
  assert.equal(blocked(), 4)
})

test('workspace redirect from an auth popup cannot provide main-view logout evidence', () => {
  const { handle, terminalRedirectSignals, blocked } = fixture({
    acceptLogoutTerminalRedirect: true
  })
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  handle.view.webContents.emit('did-create-window', child, {
    url: 'https://accounts.google.com/ServiceLogin'
  })
  let prevented = false
  child.webContents.emit('will-redirect', {
    url: 'https://workspace.google.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(terminalRedirectSignals(), 0)
  assert.equal(blocked(), 1)
})

test('terminal redirect observer failure keeps the workspace redirect blocked and reports it', () => {
  const { handle, blocked } = fixture({ throwTerminalRedirect: true })
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://workspace.google.com/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(blocked(), 1)
})

test('long school SSO query keeps the safe host without retaining query data', () => {
  const { handle, diagnostics } = fixture()
  const longPrivateQuery = 'private='.padEnd(6000, 'x')
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: `https://login.school.example.edu/saml/consume?${longPrivateQuery}`,
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(diagnostics[0].hostname, 'login.school.example.edu')
  assert.equal(JSON.stringify(diagnostics[0]).includes('private='), false)
})

test('school SSO hostname remains reportable when its HTTPS URL uses a custom port', () => {
  const { handle, diagnostics } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://login.school.example.edu:8443/saml/consume?secret=value',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  assert.equal(diagnostics[0].hostname, 'login.school.example.edu')
})

test('OAuth popup and external launch failure report sanitized destinations', async () => {
  const { handle, diagnostics } = fixture()
  handle.view.webContents.openWindow({
    url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=secret'
  })
  assert.equal(diagnostics[0].reason, 'oauth_endpoint')
  const failing = fixture({ rejectOpenExternal: true })
  let prevented = false
  failing.handle.view.webContents.emit('will-frame-navigate', {
    url: 'https://login.school.example.edu/sso/private?token=secret',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, true)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(failing.diagnostics[0]), {
    source: 'external_open_failure',
    context: 'main',
    hostname: 'login.school.example.edu',
    route: 'other',
    reason: 'external_redirect'
  })
})

test('failed external launch of a mail link redacts its non-Google host', async () => {
  const failing = fixture({ rejectOpenExternal: true })
  failing.handle.view.webContents.openWindow({ url: 'https://clinic.example.com/result?id=1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(structuredClone(failing.diagnostics[0]), {
    source: 'external_open_failure',
    context: 'main',
    hostname: 'redacted',
    route: 'other',
    reason: 'external_redirect'
  })
})

test('authentication popups share the session and inherit the navigation guards', async () => {
  const { handle, webSession, opened } = fixture({ allowed: true })
  const response = handle.view.webContents.openWindow({
    url: 'https://accounts.google.com/ServiceLogin'
  })
  assert.equal(response.action, 'allow')
  const preferences = response.overrideBrowserWindowOptions.webPreferences
  assert.equal(preferences.session, webSession)
  assert.equal(preferences.sandbox, true)
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.preload, undefined)
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  let destroyed = false
  child.destroy = () => {
    destroyed = true
    child.webContents.destroyed = true
    child.webContents.emit('destroyed')
  }
  handle.view.webContents.emit('did-create-window', child, {
    url: 'https://accounts.google.com/ServiceLogin'
  })
  assert.equal(child.webContents.openWindow({ url: 'https://example.com/' }).action, 'deny')
  assert.deepEqual(opened, ['https://example.com/'])
  await handle.dispose()
  assert.equal(destroyed, true)
  assert.equal(handle.view.webContents.isDestroyed(), true)
})

test('locked Gmail view permits a Google sign-in popup and reloads after it visits auth and closes', () => {
  const { handle, webSession, reloads } = fixture()
  const popup = handle.view.webContents.openWindow({
    url: 'https://accounts.google.com/ServiceLogin'
  })
  assert.equal(popup.action, 'allow')
  const popupPreferences = popup.overrideBrowserWindowOptions.webPreferences
  assert.equal(popupPreferences.session, webSession)
  assert.equal(popupPreferences.sandbox, true)
  assert.equal(popupPreferences.contextIsolation, true)
  assert.equal(popupPreferences.nodeIntegration, false)
  assert.equal(popupPreferences.preload, undefined)
  for (const url of [
    'https://mail.google.com/mail/u/0/',
    'https://accounts.google.com/o/oauth2/v2/auth',
    'javascript:alert(1)'
  ]) {
    assert.equal(handle.view.webContents.openWindow({ url }).action, 'deny')
  }
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  child.destroy = () => {}
  handle.view.webContents.emit('did-create-window', child, {
    url: 'https://accounts.google.com/ServiceLogin'
  })
  let prevented = false
  child.webContents.emit('will-frame-navigate', {
    url: 'https://accounts.google.com/signin/v2/identifier',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, false)
  assert.equal(
    child.webContents.openWindow({ url: 'https://mail.google.com/mail/u/0/' }).action,
    'deny'
  )
  assert.equal(
    child.webContents.openWindow({ url: 'https://accounts.google.com/o/oauth2/v2/auth' }).action,
    'deny'
  )
  child.emit('closed')
  assert.equal(reloads(), 1)
  assert.equal(webSession, handle.view.options.webPreferences.session)
})

test('locked unrelated popup close does not reload the Gmail view', () => {
  const { handle, reloads } = fixture({ allowed: true })
  assert.equal(
    handle.view.webContents.openWindow({ url: 'https://mail.google.com/mail/u/0/' }).action,
    'allow'
  )
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  child.destroy = () => {}
  handle.view.webContents.emit('did-create-window', child, {
    url: 'https://mail.google.com/mail/u/0/'
  })
  child.emit('closed')
  assert.equal(reloads(), 0)
})

test('initial Google auth popup URL is enough to reload its parent when it closes', () => {
  const { handle, reloads } = fixture()
  assert.equal(
    handle.view.webContents.openWindow({ url: 'https://accounts.google.com/ServiceLogin' }).action,
    'allow'
  )
  const child = new EventEmitter()
  child.webContents = new handle.view.webContents.constructor()
  child.isDestroyed = () => false
  child.destroy = () => {}
  handle.view.webContents.emit('did-create-window', child, {
    url: 'https://accounts.google.com/ServiceLogin'
  })
  child.emit('closed')
  assert.equal(reloads(), 1)
})

test('disposing a Gmail view waits for its webContents destroyed event', async () => {
  const { handle } = fixture()
  let resolveClose
  handle.view.webContents.close = () => {
    resolveClose = () => {
      handle.view.webContents.destroyed = true
      handle.view.webContents.emit('destroyed')
    }
  }
  let finished = false
  const disposal = handle.dispose().then(() => {
    finished = true
  })
  await Promise.resolve()
  assert.equal(finished, false)
  resolveClose()
  await disposal
  assert.equal(finished, true)
})

test('OAuth and dangerous popup targets are blocked without leaving the app', () => {
  const { handle, opened, blocked } = fixture()
  for (const url of ['https://accounts.google.com/o/oauth2/v2/auth', 'javascript:alert(1)']) {
    assert.equal(handle.view.webContents.openWindow({ url }).action, 'deny')
  }
  assert.deepEqual(opened, [])
  assert.equal(blocked(), 2)
})

test('locked parent allows Gmail login redirects while remaining closed to mail popups', () => {
  const { handle, navigated } = fixture()
  let prevented = false
  handle.view.webContents.emit('will-redirect', {
    url: 'https://mail.google.com/mail/u/0/',
    isMainFrame: true,
    preventDefault() {
      prevented = true
    }
  })
  assert.equal(prevented, false)
  assert.deepEqual(navigated, ['https://mail.google.com/mail/u/0/'])
  assert.equal(
    handle.view.webContents.openWindow({ url: 'https://mail.google.com/mail/u/0/' }).action,
    'deny'
  )
})
