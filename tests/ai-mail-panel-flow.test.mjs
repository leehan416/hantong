import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const {
  requestAiMailProposal,
  applyAiMailProposal,
  undoAiMailProposal,
  createAiMailTargetEpoch,
  captureAiMailTargetSnapshot,
  isAiMailSnapshotCaptureBusy,
  finishAiMailSnapshotCapture,
  createAiMailTargetRefreshCoordinator,
  createAiMailGenerationSequence,
  applyAiMailSubjectProposal,
  undoAiMailSubjectProposal
} = loadTypeScript(new URL('../src/renderer/src/ai-mail-panel-flow.ts', import.meta.url))

test('target refresh on open updates when access and a compose target become ready', async () => {
  let status = { status: 'access_locked' }
  const accepted = []
  const refresh = createAiMailTargetRefreshCoordinator({
    query: async () => status
  })
  refresh.setActive(true)
  let outcome = await refresh.query()
  if (outcome.current) accepted.push(outcome.status)
  status = target
  outcome = await refresh.query()
  if (outcome.current) accepted.push(outcome.status)
  assert.deepEqual(
    accepted.map((value) => value.status),
    ['access_locked', 'ready']
  )
})

test('late target status cannot overwrite a newer event or account refresh', async () => {
  let resolveOld
  const accepted = []
  const refresh = createAiMailTargetRefreshCoordinator({
    query: () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  })
  refresh.setActive(true)
  const oldQuery = refresh.query()
  assert.equal(refresh.accept(), true)
  accepted.push(target)
  resolveOld({ status: 'none' })
  assert.equal((await oldQuery).current, false)
  assert.deepEqual(accepted, [target])
})

test('late target status after close or account switch is ignored', async () => {
  let resolveOld
  const accepted = []
  const refresh = createAiMailTargetRefreshCoordinator({
    query: () =>
      new Promise((resolve) => {
        resolveOld = resolve
      })
  })
  refresh.setActive(true)
  const oldQuery = refresh.query()
  refresh.setActive(false)
  refresh.setActive(true)
  assert.equal(refresh.accept(), true)
  accepted.push({ status: 'none' })
  resolveOld(target)
  assert.equal((await oldQuery).current, false)
  assert.deepEqual(accepted, [{ status: 'none' }])
})

test('generation numbers increase per compose across actions and account switches', () => {
  const sequence = createAiMailGenerationSequence()

  assert.deepEqual(
    [
      sequence.next('account-a:compose-1'),
      sequence.next('account-b:compose-2'),
      sequence.next('account-a:compose-1')
    ],
    [1, 1, 2]
  )
})

test('a snapshot started for A is invalid after switching A to B and back to A', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  const capture = epoch.capture('account-a:compose-1')
  let resolveSnapshot
  const pendingSnapshot = captureAiMailTargetSnapshot(
    epoch,
    capture,
    () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve
      })
  )

  epoch.setTarget('account-b:compose-2')
  epoch.setTarget('account-a:compose-1')
  resolveSnapshot(snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(await pendingSnapshot)), { status: 'stale' })
})

test('a current target capture returns its snapshot', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  const capture = epoch.capture('account-a:compose-1')

  const outcome = await captureAiMailTargetSnapshot(epoch, capture, async () => snapshot)

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'ready', result: snapshot })
})

test('a snapshot error after switching targets is discarded as stale', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  const capture = epoch.capture('account-a:compose-1')
  let rejectSnapshot
  const pendingSnapshot = captureAiMailTargetSnapshot(
    epoch,
    capture,
    () =>
      new Promise((resolve, reject) => {
        void resolve
        rejectSnapshot = reject
      })
  )

  epoch.setTarget('account-b:compose-2')
  rejectSnapshot(new Error('synthetic snapshot failure'))
  assert.deepEqual(JSON.parse(JSON.stringify(await pendingSnapshot)), { status: 'stale' })
})

test('a token invalidated by closing cannot start a snapshot call', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  const capture = epoch.capture('account-a:compose-1')
  epoch.invalidate()
  let snapshotCalls = 0
  const outcome = await captureAiMailTargetSnapshot(epoch, capture, async () => {
    snapshotCalls += 1
    return snapshot
  })

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
  assert.equal(snapshotCalls, 0)
})

test('reopening detaches capture A so its late success cannot clear capture B', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  let session = 0
  const captureAToken = { ...epoch.capture('account-a:compose-1'), session }
  let currentCapture = captureAToken
  let resolveA
  const captureA = captureAiMailTargetSnapshot(
    epoch,
    captureAToken,
    () =>
      new Promise((resolve) => {
        resolveA = resolve
      })
  )

  epoch.invalidate()
  session += 1
  assert.equal(isAiMailSnapshotCaptureBusy(false, session, currentCapture), false)
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), false)
  const captureB = { ...epoch.capture('account-a:compose-1'), session }
  currentCapture = captureB
  let resolveB
  const pendingB = captureAiMailTargetSnapshot(
    epoch,
    captureB,
    () =>
      new Promise((resolve) => {
        resolveB = resolve
      })
  )

  resolveA(snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(await captureA)), { status: 'stale' })
  currentCapture = finishAiMailSnapshotCapture(currentCapture, captureAToken)
  assert.equal(currentCapture, captureB)
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), true)

  resolveB(snapshot)
  assert.deepEqual(JSON.parse(JSON.stringify(await pendingB)), {
    status: 'ready',
    result: snapshot
  })
  currentCapture = finishAiMailSnapshotCapture(currentCapture, captureB)
  assert.equal(currentCapture, null)
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), false)
})

test('reopening detaches capture A so its late error cannot clear capture B error state', async () => {
  const epoch = createAiMailTargetEpoch()
  epoch.setTarget('account-a:compose-1')
  let session = 0
  const captureAToken = { ...epoch.capture('account-a:compose-1'), session }
  let currentCapture = captureAToken
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), true)
  let rejectA
  const captureA = captureAiMailTargetSnapshot(
    epoch,
    captureAToken,
    () =>
      new Promise((resolve, reject) => {
        void resolve
        rejectA = reject
      })
  )

  epoch.invalidate()
  session += 1
  const captureB = { ...epoch.capture('account-a:compose-1'), session }
  currentCapture = captureB
  let rejectB
  const pendingB = captureAiMailTargetSnapshot(
    epoch,
    captureB,
    () =>
      new Promise((resolve, reject) => {
        void resolve
        rejectB = reject
      })
  )

  rejectA(new Error('old capture failed'))
  assert.deepEqual(JSON.parse(JSON.stringify(await captureA)), { status: 'stale' })
  currentCapture = finishAiMailSnapshotCapture(currentCapture, captureAToken)
  assert.equal(currentCapture, captureB)
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), true)

  rejectB(new Error('current capture failed'))
  assert.deepEqual(JSON.parse(JSON.stringify(await pendingB)), { status: 'error' })
  currentCapture = finishAiMailSnapshotCapture(currentCapture, captureB)
  assert.equal(currentCapture, null)
  assert.equal(isAiMailSnapshotCaptureBusy(true, session, currentCapture), false)
})

const target = {
  status: 'ready',
  accountId: 'account-a',
  composeId: 'compose-1',
  accountLabel: 'Synthetic account',
  recipients: ['recipient@example.test'],
  subject: 'Synthetic subject'
}

const snapshot = {
  ...target,
  documentVersion: 'version-1',
  snapshotId: 'snapshot-1',
  body: 'Synthetic draft body'
}

test('explicit request captures only its target and renders a synthetic proposal', async () => {
  let sentRequest
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => snapshot,
      generateAiMailDraft: async (request) => {
        sentRequest = request
        return {
          ok: true,
          text: 'Synthetic proposal',
          usage: { inputTokens: null, outputTokens: null }
        }
      }
    },
    target,
    'Make this more concise',
    'request-1',
    1
  )

  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.text, 'Synthetic proposal')
  assert.equal(sentRequest.accountId, target.accountId)
  assert.equal(sentRequest.composeId, target.composeId)
  assert.match(sentRequest.prompt, /Synthetic draft body/)
  assert.doesNotMatch(sentRequest.prompt, /recipient@example\.test/)
})

test('subject recommendation returns separate subject and body fields and never includes JSON in the body', async () => {
  let sentRequest
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => snapshot,
      generateAiMailDraft: async (request) => {
        sentRequest = request
        return {
          ok: true,
          text: JSON.stringify({ subject: 'Suggested subject', body: 'Suggested body' }),
          usage: { inputTokens: null, outputTokens: null }
        }
      }
    },
    target,
    'subject',
    'request-subject',
    1,
    undefined,
    { task: 'subject' }
  )

  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.task, 'subject')
  assert.equal(outcome.text, 'Suggested body')
  assert.equal(outcome.subject, 'Suggested subject')
  assert.match(sentRequest.prompt, /Synthetic subject/)
  assert.match(sentRequest.prompt, /Synthetic draft body/)
})

test('summary and translation capture the currently opened received email, separately from compose', async () => {
  const prompts = []
  let composeReads = 0
  let readReads = 0
  const api = {
    getAiMailComposeSnapshot: async () => {
      composeReads += 1
      return snapshot
    },
    getAiMailReadSnapshot: async () => {
      readReads += 1
      return {
        status: 'ready',
        accountId: 'account-a',
        captureId: 'capture-1',
        subject: 'Received message subject',
        body: 'Received message body'
      }
    },
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async (request) => {
      prompts.push(request.prompt)
      return {
        ok: true,
        text:
          prompts.length === 1
            ? 'Short summary'
            : '{"subject":"Translated subject","body":"Translated body"}',
        usage: { inputTokens: null, outputTokens: null }
      }
    }
  }
  const summary = await requestAiMailProposal(
    api,
    null,
    '',
    'request-summary',
    1,
    undefined,
    {
      task: 'summary'
    },
    'account-a'
  )
  const translation = await requestAiMailProposal(
    api,
    null,
    '',
    'request-translation',
    1,
    undefined,
    { task: 'translate', targetLanguage: 'Korean' },
    'account-a'
  )
  assert.equal(summary.status, 'ready', JSON.stringify(summary))
  assert.equal(translation.status, 'ready', JSON.stringify(translation))

  assert.equal(summary.status, 'ready')
  assert.equal(summary.owner, 'read')
  assert.equal(summary.snapshot.captureId, 'capture-1')
  assert.equal('composeId' in summary.snapshot, false)
  assert.equal(summary.task, 'summary')
  assert.equal(summary.text, 'Short summary')
  assert.equal(translation.status, 'ready')
  assert.equal(translation.owner, 'read')
  assert.equal(translation.text, 'Translated body')
  assert.equal(translation.subject, 'Translated subject')
  assert.match(prompts[0], /Received message subject/)
  assert.match(prompts[0], /Received message body/)
  assert.match(prompts[1], /Korean/)
  assert.equal(readReads, 2)
  assert.equal(composeReads, 0)
})

test('received-mail generation discards a result after its capture lease changes', async () => {
  const outcome = await requestAiMailProposal(
    {
      getAiMailReadSnapshot: async () => ({
        status: 'ready',
        accountId: 'account-a',
        accountLabel: 'A',
        captureId: 'read-lease',
        subject: 'Read',
        body: 'Body'
      }),
      isAiMailReadSnapshotCurrent: async () => false,
      getAiMailComposeSnapshot: async () => snapshot,
      generateAiMailDraft: async () => ({
        ok: true,
        text: 'Summary',
        usage: { inputTokens: null, outputTokens: null }
      })
    },
    null,
    '',
    'read-stale',
    1,
    undefined,
    { task: 'summary' },
    'account-a'
  )
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
})

test('subject recommendation has a versioned direct apply and undo path', async () => {
  const calls = []
  const api = {
    applyAiMailSubject: async (request) => {
      calls.push({ operation: 'apply', request })
      return { status: 'applied', applyId: 'subject-apply-1' }
    },
    undoAiMailSubject: async (request) => {
      calls.push({ operation: 'undo', request })
      return { status: 'undone' }
    }
  }
  const applied = await applyAiMailSubjectProposal(api, snapshot, 'New subject')
  assert.deepEqual(applied, { status: 'applied', applyId: 'subject-apply-1' })
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {
    operation: 'apply',
    request: {
      accountId: snapshot.accountId,
      composeId: snapshot.composeId,
      documentVersion: snapshot.documentVersion,
      snapshotId: snapshot.snapshotId,
      replacement: 'New subject'
    }
  })
  assert.deepEqual(await undoAiMailSubjectProposal(api, snapshot, 'subject-apply-1'), {
    status: 'undone'
  })
})

test('malformed structured subject output fails closed', async () => {
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => snapshot,
      generateAiMailDraft: async () => ({
        ok: true,
        text: 'subject: hi\nbody: hello',
        usage: { inputTokens: null, outputTokens: null }
      })
    },
    target,
    '',
    'request-invalid',
    1,
    undefined,
    { task: 'subject' }
  )

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'invalid_output' })
})

test('translation requires an explicit target language before capturing or generating', async () => {
  let snapshotCalls = 0
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => {
        snapshotCalls += 1
        return snapshot
      },
      generateAiMailDraft: async () => {
        assert.fail('translation must not generate without a target language')
      }
    },
    target,
    '',
    'request-language-required',
    1,
    undefined,
    { task: 'translate' }
  )

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
    status: 'invalid_request',
    reason: 'target_language_required'
  })
  assert.equal(snapshotCalls, 0)
})

test('unsupported generation remains a failure and cannot create a proposal', async () => {
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => snapshot,
      generateAiMailDraft: async () => ({
        ok: false,
        error: 'unsupported',
        reason: 'tool_restrictions_unverified'
      })
    },
    target,
    'Rewrite this',
    'request-2',
    1
  )

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
    status: 'failed',
    result: { ok: false, error: 'unsupported', reason: 'tool_restrictions_unverified' }
  })
})

test('a snapshot for another compose window is rejected before generation', async () => {
  let generationCalls = 0
  const outcome = await requestAiMailProposal(
    {
      getAiMailComposeSnapshot: async () => ({ ...snapshot, composeId: 'compose-2' }),
      generateAiMailDraft: async () => {
        generationCalls += 1
        return {
          ok: true,
          text: 'must not appear',
          usage: { inputTokens: null, outputTokens: null }
        }
      }
    },
    target,
    'Rewrite this',
    'request-3',
    1
  )

  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
  assert.equal(generationCalls, 0)
})

test('synthetic apply and undo preserve the captured target and support conflict confirmation', async () => {
  const applyRequests = []
  const undoRequests = []
  const api = {
    applyAiMailDraft: async (request) => {
      applyRequests.push(request)
      return applyRequests.length === 1
        ? { status: 'conflict', currentVersion: 'current-2', currentBody: 'Edited in Gmail' }
        : { status: 'applied', applyId: 'apply-1' }
    },
    undoAiMailDraft: async (request) => {
      undoRequests.push(request)
      return { status: 'undone' }
    }
  }
  const conflict = await applyAiMailProposal(api, snapshot, 'Synthetic proposal')
  assert.equal(conflict.status, 'conflict')
  const applied = await applyAiMailProposal(
    api,
    snapshot,
    'Synthetic proposal',
    conflict.currentVersion
  )
  assert.deepEqual(applied, { status: 'applied', applyId: 'apply-1' })
  assert.deepEqual(
    applyRequests.map(({ accountId, composeId }) => ({ accountId, composeId })),
    [
      { accountId: target.accountId, composeId: target.composeId },
      { accountId: target.accountId, composeId: target.composeId }
    ]
  )
  assert.equal(applyRequests[1].confirmedCurrentVersion, 'current-2')
  assert.deepEqual(await undoAiMailProposal(api, snapshot, applied.applyId), { status: 'undone' })
  assert.deepEqual(JSON.parse(JSON.stringify(undoRequests[0])), {
    accountId: target.accountId,
    composeId: target.composeId,
    documentVersion: snapshot.documentVersion,
    applyId: 'apply-1'
  })
})
