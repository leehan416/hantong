/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test fixtures are plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const {
  createGmailComposeProbeController,
  gmailComposeProbeLimits,
  gmailComposeProbeStatusMessage,
  isGmailComposeProbeOptedIn
} = loadTypeScript(new URL('../src/main/gmail-compose-probe.ts', import.meta.url))

function createFixture() {
  let now = 10
  let lastTargetId = 'compose-a'
  let editBeforeCompareAndSwap = null
  let nextPartialWrite = null
  let deferredReadBody = null
  const context = {
    accountId: 'account-a',
    activeAccountId: 'account-a',
    accountExists: true,
    webContentsId: 101,
    documentRevision: '1:1',
    accessEpoch: 1,
    accessGranted: true
  }
  const drafts = new Map([
    ['compose-a', { subject: 'Synthetic A', body: 'Original A', supported: true, reason: null }],
    ['compose-b', { subject: 'Synthetic B', body: 'Original B', supported: true, reason: null }]
  ])
  const driver = {
    async hasTarget(target) {
      return drafts.has(target.targetId)
    },
    async lastTarget() {
      return lastTargetId
    },
    async read(target) {
      const draft = drafts.get(target.targetId)
      return draft && { ...draft }
    },
    async readBody(target) {
      if (deferredReadBody) {
        const pending = deferredReadBody
        deferredReadBody = null
        pending.started()
        await pending.promise
      }
      return drafts.get(target.targetId)?.body ?? null
    },
    async replaceBody(target, expectedBody, replacement) {
      const draft = drafts.get(target.targetId)
      if (!draft?.supported) return { status: 'unsupported_format' }
      editBeforeCompareAndSwap?.(draft)
      if (draft.body !== expectedBody) return { status: 'conflict' }
      if (nextPartialWrite) {
        const partialWrite = nextPartialWrite
        nextPartialWrite = null
        const result = partialWrite(draft, replacement)
        return { status: 'partial_write', bodyAfter: result }
      }
      draft.body = replacement
      return { status: 'applied', bodyAfter: replacement }
    }
  }
  const probe = createGmailComposeProbeController({
    getContext: () => context,
    driver,
    now: () => now
  })
  return {
    context,
    drafts,
    probe,
    setLastTarget(targetId) {
      lastTargetId = targetId
    },
    setEditBeforeCompareAndSwap(callback) {
      editBeforeCompareAndSwap = callback
    },
    setNextPartialWrite(callback) {
      nextPartialWrite = callback
    },
    deferNextReadBody() {
      let start
      let resume
      const started = new Promise((resolve) => {
        start = resolve
      })
      const promise = new Promise((resolve) => {
        resume = resolve
      })
      deferredReadBody = { started: start, promise }
      return { started, resume }
    },
    advanceTime(ms) {
      now += ms
    }
  }
}

test('probe is only available through an explicit unpackaged CLI flag', () => {
  assert.equal(isGmailComposeProbeOptedIn([], false), false)
  assert.equal(isGmailComposeProbeOptedIn(['--gmail-compose-probe'], false), true)
  assert.equal(isGmailComposeProbeOptedIn(['--gmail-compose-probe'], true), false)
})

test('probe result logging drops subjects, bodies and unexpected status data', () => {
  const output = gmailComposeProbeStatusMessage('read', {
    status: 'ready',
    subject: 'private synthetic subject marker',
    body: 'private synthetic body marker',
    email: 'private@example.test'
  })
  assert.equal(output, 'Compose snapshot captured in Main memory.')
  assert.doesNotMatch(output, /private|subject|body|@/i)
  assert.equal(
    gmailComposeProbeStatusMessage('replacement', {
      status: 'user@example.test\nbody text',
      body: 'private marker'
    }),
    'replacement result: operation_failed_safely.'
  )
})

test('limits bound snapshots and expire stale reads', async () => {
  const fixture = createFixture()
  assert.equal(gmailComposeProbeLimits.maxBodyLength, 20_000)
  assert.equal(gmailComposeProbeLimits.snapshotTtlMs, 300_000)
  assert.equal(await fixture.probe.observeLastUsedTarget(), true)
  assert.equal((await fixture.probe.read()).status, 'ready')
  fixture.advanceTime(300_001)
  assert.equal((await fixture.probe.replaceSample()).status, 'expired_snapshot')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('last used compose remains selected while the local panel has focus', async () => {
  const fixture = createFixture()
  assert.equal(await fixture.probe.observeLastUsedTarget(), true)
  // No Gmail focus event occurs when the Main terminal receives the command.
  const read = await fixture.probe.read()
  assert.equal(read.status, 'ready')
})

test('a read after selecting a second compose stays bound to its captured target', async () => {
  const fixture = createFixture()
  assert.equal(await fixture.probe.observeLastUsedTarget(), true)
  assert.equal((await fixture.probe.read()).status, 'ready')
  fixture.setLastTarget('compose-b')
  assert.equal(await fixture.probe.observeLastUsedTarget(), true)
  assert.equal((await fixture.probe.replaceSample()).status, 'applied')
  assert.equal(fixture.drafts.get('compose-a').body, 'Synthetic compose replacement for issue 33')
  assert.equal(fixture.drafts.get('compose-b').body, 'Original B')
})

test('same target re-observation and read preserve one-shot undo ownership', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  assert.equal((await fixture.probe.replaceSample()).status, 'applied')
  await fixture.probe.observeLastUsedTarget()
  assert.equal((await fixture.probe.read()).status, 'ready')
  assert.equal((await fixture.probe.undo()).status, 'undone')
  assert.equal((await fixture.probe.undo()).status, 'missing_undo')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('a partial DOM write keeps a compare-and-swap recovery action', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  fixture.setNextPartialWrite((draft, replacement) => {
    draft.body = replacement.slice(0, 8)
    return draft.body
  })
  assert.equal((await fixture.probe.replaceSample()).status, 'partial_write_recovery_available')
  assert.equal((await fixture.probe.undo()).status, 'undone')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('a partial undo retains a retryable recovery token', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  await fixture.probe.replaceSample()
  fixture.setNextPartialWrite((draft, replacement) => {
    draft.body = replacement.slice(0, 5)
    return draft.body
  })
  assert.equal((await fixture.probe.undo()).status, 'partial_undo_recovery_available')
  assert.equal((await fixture.probe.undo()).status, 'undone')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('direct edits before replace or undo are never overwritten', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  fixture.drafts.get('compose-a').body = 'User edit before replace'
  assert.equal((await fixture.probe.replaceSample()).status, 'conflict')
  assert.equal(fixture.drafts.get('compose-a').body, 'User edit before replace')

  fixture.drafts.get('compose-a').body = 'Original A'
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  await fixture.probe.replaceSample()
  fixture.drafts.get('compose-a').body = 'User edit before undo'
  assert.equal((await fixture.probe.undo()).status, 'conflict')
  assert.equal(fixture.drafts.get('compose-a').body, 'User edit before undo')
})

test('compare-and-swap catches a direct edit after Main reads the old body', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  fixture.setEditBeforeCompareAndSwap((draft) => {
    draft.body = 'User edit during apply'
  })
  assert.equal((await fixture.probe.replaceSample()).status, 'conflict')
  assert.equal(fixture.drafts.get('compose-a').body, 'User edit during apply')
})

test('replacement revalidates account and document after an awaited body read', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  const deferred = fixture.deferNextReadBody()
  const applying = fixture.probe.replaceSample()
  await deferred.started
  fixture.context.activeAccountId = 'account-b'
  deferred.resume()
  assert.equal((await applying).status, 'stale_target')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('undo revalidates account and document after an awaited body read', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  await fixture.probe.replaceSample()
  const deferred = fixture.deferNextReadBody()
  const undoing = fixture.probe.undo()
  await deferred.started
  fixture.context.documentRevision = '2:2'
  deferred.resume()
  assert.equal((await undoing).status, 'stale_target')
  assert.equal(fixture.drafts.get('compose-a').body, 'Synthetic compose replacement for issue 33')
})

test('account switch, navigation, access revoke and account removal fence operations', async (t) => {
  const transitions = [
    ['account switch', (context) => (context.activeAccountId = 'account-b')],
    ['WebContents replacement', (context) => (context.webContentsId += 1)],
    ['document navigation', (context) => (context.documentRevision = '2:2')],
    ['access revoke', (context) => (context.accessGranted = false)],
    ['account removal', (context) => (context.accountExists = false)]
  ]
  for (const [name, transition] of transitions) {
    await t.test(name, async () => {
      const fixture = createFixture()
      await fixture.probe.observeLastUsedTarget()
      await fixture.probe.read()
      transition(fixture.context)
      assert.equal((await fixture.probe.replaceSample()).status, 'stale_target')
      assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
    })
  }
})

test('account switch invalidation remains effective after returning to the old account', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  await fixture.probe.read()
  fixture.context.activeAccountId = 'account-b'
  fixture.probe.invalidate()
  fixture.context.activeAccountId = 'account-a'
  assert.equal((await fixture.probe.replaceSample()).status, 'missing_snapshot')
  assert.equal(fixture.drafts.get('compose-a').body, 'Original A')
})

test('closed targets and unsupported signature or quote content fail closed', async () => {
  const fixture = createFixture()
  await fixture.probe.observeLastUsedTarget()
  fixture.drafts.delete('compose-a')
  assert.equal((await fixture.probe.read()).status, 'stale_target')

  fixture.drafts.set('compose-rich', {
    subject: 'Synthetic signature and quote',
    body: 'Synthetic user text\nSignature\nQuoted text',
    supported: false,
    reason: 'signature_unsupported'
  })
  fixture.setLastTarget('compose-rich')
  assert.equal(await fixture.probe.observeLastUsedTarget(), true)
  assert.equal((await fixture.probe.read()).status, 'signature_unsupported')
  assert.equal(
    fixture.drafts.get('compose-rich').body,
    'Synthetic user text\nSignature\nQuoted text'
  )
})

test('oversized body is rejected without mutation', async () => {
  const fixture = createFixture()
  fixture.drafts.get('compose-a').body = 'x'.repeat(gmailComposeProbeLimits.maxBodyLength + 1)
  await fixture.probe.observeLastUsedTarget()
  assert.equal((await fixture.probe.read()).status, 'unsupported_content')
})
