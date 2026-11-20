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
  buildAiMailConversationPrompt,
  parseAiMailConversationOutput,
  applyAiMailFieldsTogether,
  isAiMailConversationVisible,
  chooseNewestComposeCandidate
} = loadTypeScript(
  new URL(
    '../src/renderer/src/components/ai-mail/AiMailPanel/ai-mail-panel-flow.ts',
    import.meta.url
  )
)

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
    1,
    'codex'
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
    1,
    'codex'
  )
  assert.equal(generationCalls, 1)
})

test('Ollama generation uses the Ollama contract and parses its structured output', async () => {
  const sent = []
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailWithOllama: async (request) => {
      sent.push(request)
      return { ok: true, output: { kind: 'answer', text: 'Local answer' } }
    },
    generateAiMailDraft: async () => assert.fail('Codex must not run for Ollama')
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Summarize this email',
    'ollama-request',
    1,
    'ollama',
    undefined,
    '4f7307bb-aee2-44f7-a218-11893a2cb88f'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.output.text, 'Local answer')
  assert.match(sent[0].prompt, /Received body/)
  assert.equal(sent[0].conversationId, '4f7307bb-aee2-44f7-a218-11893a2cb88f')
  assert.equal(sent[0].composeId, read.captureId)
})

test('compose proposal binds to captured compose and edited value is the applied value', async () => {
  const applies = []
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    getAiMailComposeSnapshot: async () => compose,
    generateAiMailDraft: async () =>
      ready('{"kind":"proposal","subject":"Suggested","body":"Suggested body"}'),
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
    1,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'compose')
  assert.equal(outcome.snapshot.composeId, 'compose-1')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'proposal',
    subject: 'Suggested',
    body: 'Suggested body'
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
    1,
    'codex'
  )
  assert.deepEqual(JSON.parse(JSON.stringify(outcome)), { status: 'stale' })
})

test('late compose result after document version change is rejected', async () => {
  let current = compose
  const api = {
    getAiMailComposeSnapshot: async () => current,
    generateAiMailDraft: async () => {
      current = { ...compose, documentVersion: 'version-2' }
      return ready('{"kind":"proposal","subject":"Stale","body":"stale edit"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Rewrite',
    'request-5',
    1,
    'codex'
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
      return ready('{"kind":"proposal","subject":"Revision","body":"revision"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Please rewrite',
    'request-stale-compose',
    1,
    'codex'
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
      return ready('{"kind":"proposal","subject":"Revision","body":"Revision"}')
    }
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Rewrite this',
    'request-latest-compose',
    1,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.snapshot.snapshotId, 'snapshot-request-time')
  assert.match(sentPrompt, /Latest subject/)
  assert.match(sentPrompt, /Latest body/)
  assert.doesNotMatch(sentPrompt, /Draft body/)
})

test('proposal without a compose stays a typed proposal and is not converted into a plain answer', async () => {
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async () => ready('{"kind":"proposal","subject":"Hello","body":"Reply"}')
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    'Draft a reply',
    'request-6',
    1,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'none')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'proposal',
    subject: 'Hello',
    body: 'Reply'
  })
})

test('labeled Korean email answer becomes separate subject and body fields for an open compose', async () => {
  const api = {
    getAiMailComposeSnapshot: async () => compose,
    generateAiMailDraft: async () =>
      ready(
        JSON.stringify({
          kind: 'answer',
          text: '제목: 모니터 수리 요청\n본문: 안녕하세요.\n모니터가 작동하지 않아 점검을 부탁드립니다.'
        })
      )
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    '고장 난 모니터에 대해 간단한 IT 메일을 써줘',
    'request-korean-fallback',
    1,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'compose')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'proposal',
    subject: '모니터 수리 요청',
    body: '안녕하세요.\n모니터가 작동하지 않아 점검을 부탁드립니다.'
  })
})

test('ordinary answer text is not reclassified as a compose proposal', () => {
  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        parseAiMailConversationOutput(
          '{"kind":"answer","text":"IT에 메일을 보내 모니터를 점검해 달라고 요청하세요."}'
        )
      )
    ),
    { kind: 'answer', text: 'IT에 메일을 보내 모니터를 점검해 달라고 요청하세요.' }
  )
})

test('labeled ordinary summary remains an answer without an explicit email writing request', async () => {
  const api = {
    getAiMailComposeSnapshot: async () => compose,
    generateAiMailDraft: async () =>
      ready('{"kind":"answer","text":"제목: 요약\\n본문: 다음 주 회의에서 일정을 논의합니다."}')
  }
  const outcome = await requestAiMailProposal(
    api,
    target,
    { accountId: 'account-a', compose, read: null },
    'Summarize the meeting notes',
    'request-summary-no-promotion',
    1,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'compose')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'answer',
    text: '제목: 요약\n본문: 다음 주 회의에서 일정을 논의합니다.'
  })
})

test('no-compose proposal remains structured so the panel can preserve editable fields and guidance', async () => {
  const api = {
    isAiMailReadSnapshotCurrent: async () => true,
    generateAiMailDraft: async () =>
      ready('{"kind":"proposal","subject":"안내","body":"본문 제안"}')
  }
  const outcome = await requestAiMailProposal(
    api,
    null,
    { accountId: 'account-a', compose: null, read },
    '메일 답장을 작성해 줘',
    'request-preserve-proposal',
    2,
    'codex'
  )
  assert.equal(outcome.status, 'ready')
  assert.equal(outcome.owner, 'none')
  assert.deepEqual(JSON.parse(JSON.stringify(outcome.output)), {
    kind: 'proposal',
    subject: '안내',
    body: '본문 제안'
  })
})

test('unified draft apply rolls back the subject when body apply fails', async () => {
  const calls = []
  const result = await applyAiMailFieldsTogether(
    async () => {
      calls.push('apply-subject')
      return { status: 'applied', applyId: 'subject-apply' }
    },
    async () => {
      calls.push('apply-body')
      return { status: 'conflict' }
    },
    async (applyId) => {
      calls.push(`undo-${applyId}`)
      return { status: 'undone' }
    }
  )
  assert.equal(result.status, 'rolled_back')
  assert.deepEqual(calls, ['apply-subject', 'apply-body', 'undo-subject-apply'])
})

test('body IPC rejection rolls back the subject and keeps its receipt when rollback rejects', async () => {
  const calls = []
  const result = await applyAiMailFieldsTogether(
    async () => ({ status: 'applied', applyId: 'subject-receipt-a' }),
    async () => {
      calls.push('body-rejected')
      throw new Error('renderer IPC rejected')
    },
    async (applyId) => {
      calls.push(`undo-${applyId}`)
      throw new Error('rollback IPC rejected')
    }
  )
  assert.equal(result.status, 'partial')
  assert.equal(result.subject.applyId, 'subject-receipt-a')
  assert.equal(result.body.status, 'failed')
  assert.deepEqual(calls, ['body-rejected', 'undo-subject-receipt-a'])
})

test('compose proposal target requires one strictly newest known activity', () => {
  const candidates = [
    { composeId: 'older', label: 'Older', lastUsedAt: 20 },
    { composeId: 'newer', label: 'Newer', lastUsedAt: 30 }
  ]
  assert.equal(chooseNewestComposeCandidate(candidates), 'newer')
  assert.equal(
    chooseNewestComposeCandidate([...candidates, { ...candidates[1], composeId: 'tie' }]),
    null
  )
  assert.equal(
    chooseNewestComposeCandidate([
      ...candidates,
      { composeId: 'unknown', label: 'Unknown', lastUsedAt: 0 }
    ]),
    null
  )
})

test('unified draft apply reports partial state when rollback fails', async () => {
  const result = await applyAiMailFieldsTogether(
    async () => ({ status: 'applied', applyId: 'subject-apply' }),
    async () => ({ status: 'failed' }),
    async () => ({ status: 'stale' })
  )
  assert.equal(result.status, 'partial')
})

test('conversation remains visible across same-account mail context changes and hides across accounts', () => {
  assert.equal(isAiMailConversationVisible('account-a', 'account-a'), true)
  assert.equal(isAiMailConversationVisible('account-a', 'account-b'), false)
  assert.equal(isAiMailConversationVisible('account-a', null), false)
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

test('no-compose prompt keeps an explicitly requested draft structured and unbound', () => {
  const prompt = buildAiMailConversationPrompt('Write an email reply', {
    accountId: 'account-a',
    compose: null,
    read
  })
  assert.match(prompt, /explicitly asks to write or revise an email[\s\S]*typed proposal/i)
  assert.match(prompt, /remains unbound until the user explicitly binds/i)
  assert.doesNotMatch(prompt, /return a reply suggestion as an answer/i)
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
