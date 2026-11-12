import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { requestAiMailProposal, applyAiMailProposal, undoAiMailProposal } = loadTypeScript(
  new URL('../src/renderer/src/ai-mail-panel-flow.ts', import.meta.url)
)

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
