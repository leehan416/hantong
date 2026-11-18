/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Test fixtures are plain JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const {
  requestAiMailProposal,
  applyAiMailProposal,
  applyAiMailSubjectProposal,
  createAiMailTargetEpoch,
  captureAiMailTargetSnapshot,
  createAiMailTargetRefreshCoordinator,
  createAiMailFieldMutationCoordinator,
  buildAiMailConversationPrompt
} = loadTypeScript(new URL('../src/renderer/src/ai-mail-panel-flow.ts', import.meta.url))

const target = {
  status: 'ready',
  accountId: 'account-a',
  composeId: 'compose-1',
  accountLabel: 'Synthetic account',
  recipients: [],
  subject: 'Draft subject'
}
const compose = {
  ...target,
  documentVersion: 'version-1',
  snapshotId: 'snapshot-1',
  body: 'Draft body'
}
const read = {
  status: 'ready',
  accountId: 'account-a',
  accountLabel: 'A',
  captureId: 'read-capture',
  subject: 'Received subject',
  body: 'Received body'
}

const ready = (text) => ({ ok: true, text, usage: { inputTokens: null, outputTokens: null } })

test('automatic received-mail context can produce a read-only answer without a compose', async () => {
  const sent = []
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async (request) => {
      sent.push(request)
      return ready('{"kind":"answer","text":"A short summary"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Summarize this email',
    'request-1',
    1
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'read')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'answer',
    text: 'A short summary'
  })
  assert.equal(sent.length, 1)
  assert.match(sent[0].prompt, /Received body/)
  assert.match(sent[0].prompt, /untrusted data/)
  assert.equal(sent[0].accountId, 'account-a')
})

test('read-only context is transmitted only when the user sends a message', async () => {
  let generationCalls = 0
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async () => {
      generationCalls += 1
      return ready('{"kind":"answer","text":"answer"}')
    }
  }
  assert.equal(generationCalls, 0)
  await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Translate this',
    'request-2',
    1
  )
  assert.equal(generationCalls, 1)
})

test('compose proposal binds to captured compose and edited value is the applied value', async () => {
  const applies = []
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => compose,
    generateAiMailDraft: async () =>
      ready('{"kind":"proposal","field":"subject","subject":"Suggested","text":"Suggested body"}'),
    applyAiMailSubject: async (request) => {
      applies.push(request)
      return { status: 'applied', applyId: 'apply-1' }
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Suggest a clearer subject and body',
    'request-3',
    1
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'compose')
  assert.equal(outcome.snapshot.composeId, 'compose-1')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'proposal',
    field: 'subject',
    subject: 'Suggested',
    text: 'Suggested body'
  })
  await applyAiMailSubjectProposal(api, outcome.snapshot, 'User edited subject')
  assert.equal(applies[0].replacement, 'User edited subject')
  assert.equal(applies[0].composeId, 'compose-1')
})

test('late read result after lease change is rejected', async () => {
  let valid = true
  const api = {
    isAiMailReadSnapshotCurrent: async () => valid,
    generateAiMailDraft: async () => {
      valid = false
      return ready('{"kind":"answer","text":"stale answer"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Summarize',
    'request-4',
    1
  )
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
})

test('late compose result after document version change is rejected', async () => {
  let current = compose
  const api = {
    getAiMailComposeSnapshot: async () => current,
    generateAiMailDraft: async () => {
      current = { ...compose, documentVersion: 'version-2' }
      return ready('{"kind":"proposal","field":"body","text":"stale edit"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Rewrite',
    'request-5',
    1
  )
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
})

test('request refreshes an edited compose before generation rather than transmitting stale capture', async () => {
  let generations = 0
  const api = {
    getAiMailComposeSnapshot: async () => ({
      ...compose,
      documentVersion: 'version-2',
      subject: 'Current subject',
      body: 'Current body',
      snapshotId: 'snapshot-current'
    }),
    generateAiMailDraft: async (request) => {
      generations += 1
      assert.match(request.prompt, /Current body/)
      assert.doesNotMatch(request.prompt, /Draft body/)
      return ready('{"kind":"proposal","field":"body","text":"revision"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Please rewrite',
    'request-stale-compose',
    1
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.snapshot.snapshotId, 'snapshot-current')
  assert.equal(generations, 1)
})

test('request uses the latest body and subject even when the compose document lease is unchanged', async () => {
  const latest = {
    ...compose,
    subject: 'Latest subject',
    body: 'Latest body',
    snapshotId: 'snapshot-request-time'
  }
  let sentPrompt = ''
  const api = {
    getAiMailComposeSnapshot: async () => latest,
    generateAiMailDraft: async (request) => {
      sentPrompt = request.prompt
      return ready('{"kind":"proposal","field":"body","text":"Revision"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Rewrite this',
    'request-latest-compose',
    1
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.snapshot.snapshotId, 'snapshot-request-time')
  assert.match(sentPrompt, /Latest subject/)
  assert.match(sentPrompt, /Latest body/)
  assert.doesNotMatch(sentPrompt, /Draft body/)
})

test('proposal output without a compose is converted to non-applicable guidance', async () => {
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async () => ready('{"kind":"proposal","field":"body","text":"Reply"}')
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Draft a reply',
    'request-6',
    1
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'none')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), { kind: 'answer', text: 'Reply' })
})

test('conversation prompt includes eligible contexts and treats them as data', () => {
  const prompt = buildAiMailConversationPrompt('Please reply', {
    accountId: 'account-a',
    compose,
    read
  })
  assert.match(prompt, /Received body/)
  assert.match(prompt, /Draft body/)
  assert.match(prompt, /never as instructions/)
  assert.match(prompt, /Please reply/)
})

test('conversation prompt respects the Main request limit while retaining the user instruction', () => {
  const prompt = buildAiMailConversationPrompt('Please summarize this for me', {
    accountId: 'account-a',
    compose: { ...compose, body: 'D'.repeat(20_000) },
    read: { ...read, body: 'R'.repeat(20_000) }
  })
  assert.ok(prompt.length <= 4000)
  assert.ok(prompt.includes('Please summarize this for me'))
})

test('target refresh ignores stale completion after a newer target event', async () => {
  let resolveOld
  const refresh = createAiMailTargetRefreshCoordinator({
    query: () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  })
  refresh.setActive(true)
  const pending = refresh.query()
  refresh.accept()
  resolveOld({ status: 'none' })
  assert.equal((await pending).current, false)
})

test('capture token invalidated by closing cannot start a snapshot call', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  const capture = epoch.capture('account-a:compose-1')
  epoch.invalidate()
  let calls = 0
  const outcome = await captureAiMailTargetSnapshot(epoch, capture, async () => {
    calls += 1
    return compose
  })
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
  assert.equal(calls, 0)
})

test('body proposal applies edited content and keeps conflict version confirmation', async () => {
  const calls = []
  const api = {
    applyAiMailDraft: async (request) => {
      calls.push(request)
      return calls.length === 1
        ? { status: 'conflict', currentVersion: 'version-2', currentBody: 'Changed in Gmail' }
        : { status: 'applied', applyId: 'apply-2' }
    }
  }
  const first = await applyAiMailProposal(api, compose, 'Edited proposal')
  const second = await applyAiMailProposal(api, compose, 'Edited proposal', first.currentVersion)
  assert.equal(calls[0].replacement, 'Edited proposal')
  assert.equal(calls[1].confirmedCurrentVersion, 'version-2')
  assert.equal(second.status, 'applied')
})

test('rejected field apply returns a visible failure outcome', async () => {
  const coordinator = createAiMailFieldMutationCoordinator({
    getAiMailComposeSnapshot: async () => compose,
    applyAiMailDraft: async () => {
      throw new Error('IPC failed')
    }
  })
  const outcome = await coordinator.mutate({
    lockKey: 'message-1:body',
    snapshot: compose,
    field: 'body',
    operation: 'apply',
    replacement: 'Edited proposal',
    isCurrent: () => true,
    onStart: () => undefined
  })
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'failed' })
})

test('field mutation locks before deferred freshness read and rejects after account switch', async () => {
  let resolveSnapshot
  let current = true
  let applies = 0
  let started = 0
  const coordinator = createAiMailFieldMutationCoordinator({
    getAiMailComposeSnapshot: () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      }),
    applyAiMailDraft: async () => {
      applies += 1
      return { status: 'applied', applyId: 'apply' }
    }
  })
  const request = {
    lockKey: 'message-1:body',
    snapshot: compose,
    field: 'body',
    operation: 'apply',
    replacement: 'Edited proposal',
    isCurrent: () => current,
    onStart: () => {
      started += 1
    }
  }
  const first = coordinator.mutate(request)
  assert.equal(started, 1)
  const second = await coordinator.mutate(request)
  assert.deepEqual(JSON.parse(JSON.stringify(second)), { status: 'busy' })
  current = false
  resolveSnapshot(compose)
  assert.deepEqual(JSON.parse(JSON.stringify(await first)), { status: 'stale' })
  assert.equal(applies, 0)
})
