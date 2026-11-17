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
  finishAiMailSnapshotCapture
} = loadTypeScript(new URL('../src/renderer/src/ai-mail-panel-flow.ts', import.meta.url))

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
