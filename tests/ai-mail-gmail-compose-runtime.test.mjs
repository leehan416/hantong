/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test doubles are plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { loadTypeScript } from './helpers/load-typescript.mjs'
import {
  firstId,
  secondId,
  fixture as accountViewFixture
} from './helpers/account-view-fixture.mjs'

const { createGmailComposeProbeRuntime } = loadTypeScript(
  new URL('../src/main/gmail-compose-probe.ts', import.meta.url)
)
const { createAccountAccessController } = loadTypeScript(
  new URL('../src/main/account-access-controller.ts', import.meta.url)
)

function createRuntimeFixture(options = {}) {
  let accessStatus = 'required'
  let granted = false
  const executed = []
  const listeners = new Map()
  const contents = {
    id: 404,
    isDestroyed: () => false,
    on(event, listener) {
      listeners.set(event, listener)
      return this
    },
    removeListener(event) {
      listeners.delete(event)
      return this
    },
    executeJavaScriptInIsolatedWorld(worldId, scripts) {
      const code = scripts[0].code
      executed.push({ worldId, code })
      if (code.includes('.lastTarget()')) return Promise.resolve('compose-target')
      if (code.includes('.hasTarget(')) return Promise.resolve(true)
      if (code.includes('.read('))
        return Promise.resolve({
          subject: 'synthetic subject marker',
          body: 'synthetic body marker',
          supported: true,
          reason: null
        })
      if (options.installError && code.includes('__hantongGmailComposeProbe'))
        return Promise.reject(options.installError)
      if (options.installResult !== undefined && code.includes('__hantongGmailComposeProbe'))
        return Promise.resolve(options.installResult)
      options.onInstall?.()
      return Promise.resolve(true)
    }
  }
  let pendingLine
  const terminal = {
    question(_prompt, callback) {
      pendingLine = callback
    },
    on() {
      return this
    },
    close() {
      return this
    },
    answer(line) {
      const callback = pendingLine
      pendingLine = null
      callback(line)
    }
  }
  const runtime = createGmailComposeProbeRuntime({
    window: { isDestroyed: () => false },
    views: {
      getActiveAccountId: () => 'authorized-test-account',
      getComposeProbeView: () =>
        granted ? { contents, navigationRevision: 3, accessRevision: 7 } : null
    },
    access: { getState: () => ({ status: accessStatus }) },
    accountExists: () => true,
    isPackaged: false,
    argv: ['--gmail-compose-probe', '--gmail-compose-probe-isolated'],
    terminal
  })
  return {
    runtime,
    contents,
    executed,
    listeners,
    terminal,
    setAccess(status, accessGranted) {
      accessStatus = status
      granted = accessGranted
    },
    async command(value) {
      terminal.answer(value)
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

class SyntheticElement {
  constructor(tagName, attributes = {}, innerText = '') {
    this.tagName = tagName.toUpperCase()
    this.attributes = Object.entries(attributes).map(([name, value]) => ({ name, value }))
    this.parentElement = null
    this.children = []
    this.isConnected = true
    this.innerText = innerText
    this.value = ''
  }

  append(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  matches(selector) {
    if (selector === '[contenteditable="true"]')
      return this.attributes.some(
        (attribute) => attribute.name === 'contenteditable' && attribute.value === 'true'
      )
    if (selector === 'input[name="subjectbox"]')
      return (
        this.tagName === 'INPUT' &&
        this.attributes.some(
          (attribute) => attribute.name === 'name' && attribute.value === 'subjectbox'
        )
      )
    if (selector === '[role="dialog"]')
      return this.attributes.some(
        (attribute) => attribute.name === 'role' && attribute.value === 'dialog'
      )
    return false
  }

  closest(selector) {
    if (this.matches(selector)) return this
    return this.parentElement?.closest(selector) ?? null
  }

  querySelectorAll(selector) {
    const matches = []
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child)
        visit(child)
      }
    }
    visit(this)
    return matches
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  contains(node) {
    for (let current = node; current; current = current.parentElement)
      if (current === this) return true
    return false
  }
}

class SyntheticInput extends SyntheticElement {}

function createSyntheticProbe(
  source,
  { composeCount = 2, sharedDialog = true, scopedComposes = true } = {}
) {
  const dialog = new SyntheticElement('div', sharedDialog ? { role: 'dialog' } : {})
  const composes = []
  for (let index = 1; index <= composeCount; index += 1) {
    const scope = scopedComposes ? dialog.append(new SyntheticElement('section')) : dialog
    const subject = scope.append(new SyntheticInput('input', { name: 'subjectbox' }))
    subject.value = `synthetic-subject-${index}`
    const editor = scope.append(
      new SyntheticElement('div', { contenteditable: 'true' }, `synthetic-body-${index}`)
    )
    editor.append(new SyntheticElement('span'))
    composes.push({ subject, editor, scope })
  }
  const listeners = new Map()
  let selection = null
  const document = {
    activeElement: null,
    addEventListener(name, listener) {
      listeners.set(name, listener)
    },
    removeEventListener(name) {
      listeners.delete(name)
    },
    getSelection: () => selection,
    createTreeWalker: () => ({ nextNode: () => null })
  }
  const context = {
    document,
    Element: SyntheticElement,
    HTMLInputElement: SyntheticInput,
    NodeFilter: { SHOW_ELEMENT: 1 }
  }
  runInNewContext(source, context)
  const probe = context.__hantongGmailComposeProbe
  const dispatch = (type, target) => listeners.get(type)?.({ target })
  return {
    composes,
    probe,
    document,
    dispatch,
    setSelection(ranges) {
      selection = {
        rangeCount: ranges.length,
        getRangeAt: (index) => ranges[index]
      }
    }
  }
}

async function installedProbeSource() {
  const fixture = createRuntimeFixture()
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  const source = fixture.executed[0].code
  fixture.runtime.dispose()
  return source
}

test('runtime requires the real Main access state before it installs or uses the probe', async () => {
  const fixture = createRuntimeFixture()
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.executed.length, 0)

  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.executed.length, 1)
  assert.equal(fixture.executed[0].worldId, 7913)
  assert.ok(fixture.listeners.has('did-start-navigation'))
  await fixture.command('read')
  const beforeRevocation = fixture.executed.length

  fixture.setAccess('required', false)
  fixture.runtime.onAccessState({
    accountId: 'authorized-test-account',
    status: 'required',
    connectionStatus: 'disconnected'
  })
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('replace-sample')
  await fixture.command('undo')
  assert.equal(fixture.executed.length, beforeRevocation + 1)
  assert.ok(fixture.executed.at(-1).code.includes('.revoke()'))
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.replace(')))
  fixture.runtime.dispose()
})

test('runtime remains locked when isolated-world probe installation rejects', async () => {
  const fixture = createRuntimeFixture({ installError: new Error('synthetic install rejection') })
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('read')
  assert.ok(fixture.executed.length >= 1)
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.lastTarget()')))
  fixture.runtime.dispose()
})

test('runtime revokes a stale installation when the access context changes while awaiting it', async () => {
  let fixture
  fixture = createRuntimeFixture({
    onInstall() {
      fixture.setAccess('required', false)
    }
  })
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  assert.equal(fixture.listeners.size, 0)
  await fixture.command('read')
  assert.ok(fixture.executed.every(({ code }) => !code.includes('.lastTarget()')))
  fixture.runtime.dispose()
})

test('read-only runtime page source exposes no DOM mutation operation', async () => {
  const fixture = createRuntimeFixture()
  fixture.setAccess('ready', true)
  await fixture.command('authorize-synthetic-test-account')
  const source = fixture.executed[0].code
  assert.ok(source.includes('revoke()'))
  assert.match(source, /3:7:0:[0-9a-f-]{36}/)
  assert.ok(source.includes('[contenteditable="true"]'))
  assert.ok(source.includes("document.addEventListener('click', remember, true)"))
  assert.ok(
    source.includes("document.addEventListener('selectionchange', rememberSelection, true)")
  )
  assert.ok(
    source.includes("document.removeEventListener('selectionchange', rememberSelection, true)")
  )
  assert.ok(!source.includes('execCommand'))
  assert.ok(!source.includes('insertText'))
  assert.ok(!source.includes('replace(id'))
  fixture.runtime.dispose()
})

test('synthetic DOM pairs an editor with its own subject under a shared Gmail dialog', async () => {
  const probe = createSyntheticProbe(await installedProbeSource())
  const second = probe.composes[1]
  probe.document.activeElement = second.editor
  probe.dispatch('click', second.editor)
  const targetId = probe.probe.lastTarget()
  assert.ok(targetId)
  assert.equal(probe.probe.read(targetId).subject, 'synthetic-subject-2')
  assert.equal(probe.probe.read(targetId).body, 'synthetic-body-2')
})

test('synthetic DOM rejects an ambiguous shared wrapper with multiple compose pairs', async () => {
  const probe = createSyntheticProbe(await installedProbeSource(), { scopedComposes: false })
  const second = probe.composes[1]
  probe.document.activeElement = second.editor
  probe.dispatch('click', second.editor)
  assert.equal(probe.probe.lastTarget(), null)
})

test('stale document selection cannot replace the last explicitly focused compose', async () => {
  const probe = createSyntheticProbe(await installedProbeSource())
  const [first, second] = probe.composes
  probe.dispatch('focusin', first.editor)
  probe.document.activeElement = second.editor
  probe.dispatch('focusin', second.editor)
  probe.setSelection([
    { startContainer: first.editor.children[0], endContainer: first.editor.children[0] }
  ])
  probe.dispatch('selectionchange', null)
  assert.equal(probe.probe.lastTarget(), 'compose-2')
})

test('cross-editor selection cannot change the focused compose target', async () => {
  const probe = createSyntheticProbe(await installedProbeSource())
  const [first, second] = probe.composes
  probe.document.activeElement = second.editor
  probe.dispatch('click', second.editor)
  probe.setSelection([
    { startContainer: first.editor.children[0], endContainer: second.editor.children[0] }
  ])
  probe.dispatch('selectionchange', null)
  assert.equal(probe.probe.lastTarget(), 'compose-1')
})

test('deferred read is fenced by the real A-B-A account activation publish sequence', async () => {
  const published = []
  let access
  let probeRuntime
  let resolveDeferredRead
  let readStartedResolve
  const readStarted = new Promise((resolve) => {
    readStartedResolve = resolve
  })
  const messages = []
  let pendingLine
  const terminal = {
    question(_prompt, callback) {
      pendingLine = callback
    },
    on() {
      return this
    },
    close() {
      return this
    },
    answer(line) {
      const callback = pendingLine
      pendingLine = null
      callback(line)
    }
  }
  const managerFixture = accountViewFixture({
    onStatus(status) {
      if (['ready', 'blocked', 'error', 'loading'].includes(status.status))
        access?.onViewReady(status.accountId)
    }
  })
  const views = managerFixture.manager
  const accessProxy = { getState: (accountId) => access.getState(accountId) }
  probeRuntime = createGmailComposeProbeRuntime({
    window: { isDestroyed: () => false },
    views,
    access: accessProxy,
    accountExists: (accountId) =>
      managerFixture.accounts.some((account) => account.id === accountId),
    isPackaged: false,
    argv: ['--gmail-compose-probe', '--gmail-compose-probe-isolated'],
    terminal,
    logInfo: (message) => messages.push(message)
  })
  access = createAccountAccessController({
    views,
    runtime: {
      getStatus: async () => ({
        status: 'connected',
        emailAddress: 'synthetic@example.invalid'
      }),
      connect: async () => ({ status: 'connected' }),
      cancel: async () => ({ status: 'disconnected' }),
      disconnect: async () => ({ status: 'disconnected' })
    },
    connections: {
      getStatus: async () => ({
        status: 'connected',
        emailAddress: 'synthetic@example.invalid'
      }),
      getGeneration: () => 1,
      getAccessToken: async () => 'synthetic-access-token'
    },
    loadConfig: () => ({}),
    fetchProfile: async () => 'synthetic@example.invalid',
    accountExists: (accountId) =>
      managerFixture.accounts.some((account) => account.id === accountId),
    onWebIdentity: () => published.push({ accountId: 'synthetic', status: 'identity' }),
    publish(state) {
      published.push(state)
      probeRuntime.onAccessState(state)
    }
  })

  function installSyntheticPageDriver(contents) {
    contents.getTitle = () => 'Inbox - synthetic@example.invalid - Gmail'
    contents.executeJavaScriptInIsolatedWorld = (_worldId, scripts) => {
      const code = scripts[0].code
      if (code.includes('.lastTarget()')) return Promise.resolve('compose-target')
      if (code.includes('.hasTarget(')) return Promise.resolve(true)
      if (code.includes('.read(')) {
        readStartedResolve()
        return new Promise((resolve) => {
          resolveDeferredRead = resolve
        })
      }
      return Promise.resolve(true)
    }
  }

  async function waitForAccessReady(accountId) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (access.getState(accountId).status === 'ready') return
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.fail('synthetic access verification did not reach ready')
  }

  try {
    managerFixture.manager.activate(firstId)
    const contentsA = managerFixture.created[0].view.webContents
    installSyntheticPageDriver(contentsA)
    await waitForAccessReady(firstId)
    terminal.answer('authorize-synthetic-test-account')
    await new Promise((resolve) => setImmediate(resolve))
    const originalBinding = views.getComposeProbeView(firstId)
    assert.ok(originalBinding)

    terminal.answer('read')
    await readStarted
    managerFixture.manager.activate(secondId)
    managerFixture.manager.activate(firstId)
    await waitForAccessReady(firstId)

    const restoredBinding = views.getComposeProbeView(firstId)
    assert.equal(restoredBinding.contents.id, originalBinding.contents.id)
    assert.equal(restoredBinding.navigationRevision, originalBinding.navigationRevision)
    assert.equal(restoredBinding.accessRevision, originalBinding.accessRevision)
    assert.ok(
      published.some((state) => state.accountId === firstId && state.status === 'required'),
      'switching to B must publish A access revocation before returning to A'
    )
    assert.ok(
      published.some((state) => state.accountId === secondId && state.status === 'required'),
      'switching back to A must publish B access revocation'
    )

    resolveDeferredRead({
      subject: 'synthetic deferred subject',
      body: 'synthetic deferred body',
      supported: true,
      reason: null
    })
    for (
      let attempt = 0;
      attempt < 30 && !messages.some((line) => line.includes('read result'));
      attempt += 1
    )
      await new Promise((resolve) => setImmediate(resolve))
    assert.ok(
      messages.includes('read result: stale_target.'),
      `expected stale read status, got ${JSON.stringify(messages)}`
    )
    assert.ok(!messages.includes('Compose snapshot captured in Main memory.'))
  } finally {
    probeRuntime.dispose()
    access.dispose()
    await managerFixture.manager.dispose()
  }
})

test('runtime refuses packaged builds even when the probe flag is present', () => {
  assert.throws(() =>
    createGmailComposeProbeRuntime({
      window: { isDestroyed: () => false },
      views: {},
      access: {},
      accountExists: () => true,
      isPackaged: true,
      argv: ['--gmail-compose-probe', '--gmail-compose-probe-isolated'],
      terminal: {}
    })
  )
})
