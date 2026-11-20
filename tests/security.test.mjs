import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

// Compile only the pure policy module; no Electron process or network is needed.
const {
  isAllowedExternalUrl,
  isAllowedAppInfoRequest,
  isAllowedAccountRequest,
  isAllowedGoogleConnectionRequest,
  isAllowedNotificationRequest,
  isAllowedSettingsRequest,
  isAllowedLoginLaunchRequest,
  isAllowedAiMailComposeMutationRequest,
  isAllowedAiMailComposeSelectionRequest,
  isAllowedAiMailReadRequest,
  isAllowedAiMailSubjectMutationRequest,
  isAllowedClipboardWriteRequest,
  isAllowedOllamaCredentialRequest,
  isAllowedAiMailOllamaRequest,
  isTrustedRendererUrl
} = loadTypeScript(new URL('../src/main/security-policy.ts', import.meta.url))
const policy = {
  isAllowedExternalUrl,
  isAllowedAppInfoRequest,
  isAllowedAccountRequest,
  isAllowedGoogleConnectionRequest,
  isAllowedNotificationRequest,
  isTrustedRendererUrl
}

const rendererUrl =
  'file:///Applications/Hantong.app/Contents/Resources/app/out/renderer/index.html'

test('only the exact local renderer document and its hash are trusted', () => {
  assert.equal(policy.isTrustedRendererUrl(rendererUrl, rendererUrl), true)
  assert.equal(policy.isTrustedRendererUrl(`${rendererUrl}#content`, rendererUrl), true)
  for (const url of [
    `${rendererUrl}?redirect=1`,
    rendererUrl.replace('index.html', 'other.html'),
    'https://mail.google.com/',
    'file:///tmp/index.html',
    'about:blank',
    'not a URL'
  ]) {
    assert.equal(policy.isTrustedRendererUrl(url, rendererUrl), false, url)
  }
})

test('login launch IPC requires the owner main frame and exact boolean argument', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: []
  }
  assert.equal(isAllowedLoginLaunchRequest(base, 'get'), true)
  assert.equal(isAllowedLoginLaunchRequest({ ...base, args: [true] }, 'get'), false)
  assert.equal(isAllowedLoginLaunchRequest({ ...base, args: [false] }, 'set'), true)
  for (const args of [[], [1], ['true'], [true, false]])
    assert.equal(isAllowedLoginLaunchRequest({ ...base, args }, 'set'), false)
  assert.equal(
    isAllowedLoginLaunchRequest({ ...base, senderMatches: false, args: [true] }, 'set'),
    false
  )
})

test('Ollama credential IPC binds exact operation arguments to a valid HTTPS endpoint', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: ['https://ollama.com/v1']
  }
  assert.equal(isAllowedOllamaCredentialRequest(base, 'status'), true)
  assert.equal(isAllowedOllamaCredentialRequest(base, 'clear'), true)
  assert.equal(
    isAllowedOllamaCredentialRequest(
      { ...base, args: ['https://ollama.com/v1', 'key-123'] },
      'set'
    ),
    true
  )
  assert.equal(isAllowedOllamaCredentialRequest({ ...base, args: [] }, 'status'), false)
  assert.equal(
    isAllowedOllamaCredentialRequest({ ...base, args: ['http://ollama.com/v1'] }, 'status'),
    false
  )
  assert.equal(
    isAllowedOllamaCredentialRequest(
      { ...base, args: ['https://ollama.com/v1', 'key\r\nHeader: x'] },
      'set'
    ),
    false
  )
  assert.equal(isAllowedOllamaCredentialRequest({ ...base, senderMatches: false }, 'status'), false)
})

test('Ollama generation requires a UUID conversation identity separate from compose identity', () => {
  const request = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    operation: 'generate',
    args: [
      {
        accountId: 'account-a',
        composeId: 'compose-a',
        conversationId: '4f7307bb-aee2-44f7-a218-11893a2cb88f',
        requestId: 'request-a',
        generation: 1,
        prompt: 'Prompt'
      }
    ]
  }
  assert.equal(isAllowedAiMailOllamaRequest(request), true)
  for (const conversationId of [undefined, 'compose-a', 'read-capture', 'not a UUID']) {
    assert.equal(
      isAllowedAiMailOllamaRequest({
        ...request,
        args: [{ ...request.args[0], conversationId }]
      }),
      false
    )
  }
})

test('compose mutation IPC accepts only bounded explicit apply and undo requests', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: []
  }
  const apply = {
    accountId: 'account-a',
    composeId: 'compose-a',
    documentVersion: 'document-a',
    snapshotId: 'snapshot-a',
    replacement: 'Synthetic replacement'
  }
  const undo = {
    accountId: 'account-a',
    composeId: 'compose-a',
    documentVersion: 'document-a',
    applyId: 'apply-a'
  }
  assert.equal(
    isAllowedAiMailComposeMutationRequest({ ...base, operation: 'apply', args: [apply] }),
    true
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({ ...base, operation: 'undo', args: [undo] }),
    true
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({
      ...base,
      operation: 'apply',
      args: [{ ...apply, replacement: 'x'.repeat(20_001) }]
    }),
    false
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({
      ...base,
      operation: 'apply',
      args: [{ ...apply, accountId: '../account' }]
    }),
    false
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({
      ...base,
      operation: 'undo',
      args: [{ ...undo, confirmedCurrentVersion: 'x'.repeat(129) }]
    }),
    false
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({ ...base, operation: 'apply', args: [apply, 'extra'] }),
    false
  )
  assert.equal(
    isAllowedAiMailComposeMutationRequest({
      ...base,
      senderUrl: 'https://mail.google.com/',
      operation: 'apply',
      args: [apply]
    }),
    false
  )
})

test('compose candidate selection accepts only one bounded opaque identity from the trusted frame', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: [{ accountId: 'account-a', composeId: 'opaque-candidate-id' }]
  }
  assert.equal(isAllowedAiMailComposeSelectionRequest(base), true)
  assert.equal(
    isAllowedAiMailComposeSelectionRequest({ ...base, args: [{ accountId: 'account-a' }] }),
    false
  )
  assert.equal(
    isAllowedAiMailComposeSelectionRequest({
      ...base,
      args: [{ accountId: 'account-a', composeId: 'candidate', targetId: 'target-7' }]
    }),
    false
  )
  assert.equal(isAllowedAiMailComposeSelectionRequest({ ...base, mainFrameMatches: false }), false)
})

test('read-mail snapshot is read-only and subject IPC requires explicit field mutation shapes', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: []
  }
  assert.equal(isAllowedAiMailReadRequest(base), true)
  assert.equal(isAllowedAiMailReadRequest({ ...base, args: ['message-id'] }), false)
  const apply = {
    accountId: 'account-a',
    composeId: 'compose-a',
    documentVersion: 'document-a',
    snapshotId: 'snapshot-a',
    replacement: 'Subject'
  }
  const undo = {
    accountId: 'account-a',
    composeId: 'compose-a',
    documentVersion: 'document-a',
    applyId: 'apply-a'
  }
  assert.equal(
    isAllowedAiMailSubjectMutationRequest({ ...base, operation: 'apply', args: [apply] }),
    true
  )
  assert.equal(
    isAllowedAiMailSubjectMutationRequest({ ...base, operation: 'undo', args: [undo] }),
    true
  )
  assert.equal(
    isAllowedAiMailSubjectMutationRequest({ ...base, operation: 'undo', args: [apply] }),
    false
  )
  assert.equal(
    isAllowedAiMailSubjectMutationRequest({
      ...base,
      senderMatches: false,
      operation: 'apply',
      args: [apply]
    }),
    false
  )
})

test('development trust is limited to the exact configured document', () => {
  const devUrl = 'http://localhost:5173/'
  assert.equal(policy.isTrustedRendererUrl(`${devUrl}#content`, devUrl), true)
  for (const url of [
    'http://localhost:5174/',
    'http://localhost:5173/other',
    'http://localhost:5173/?query=1',
    'http://user:password@localhost:5173/',
    'https://localhost:5173/'
  ]) {
    assert.equal(policy.isTrustedRendererUrl(url, devUrl), false, url)
  }
})

test('external opening accepts only explicit HTTPS or mailto targets', () => {
  for (const url of ['https://example.com/path', 'mailto:hello@example.com']) {
    assert.equal(policy.isAllowedExternalUrl(url), true, url)
  }
  for (const url of [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/file',
    'https://user:password@example.com',
    'https://example.com\n',
    'mailto:',
    'not a URL',
    null,
    {},
    42
  ]) {
    assert.equal(policy.isAllowedExternalUrl(url), false, String(url))
  }
})

test('IPC accepts only the live owner main frame and an empty argument list', () => {
  const valid = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: []
  }
  assert.equal(policy.isAllowedAppInfoRequest(valid), true)
  for (const patch of [
    { ownerAlive: false },
    { senderMatches: false },
    { mainFrameMatches: false },
    { senderUrl: '' },
    { senderUrl: 'https://mail.google.com/' },
    { args: [undefined] },
    { args: [{ command: 'anything' }] }
  ]) {
    assert.equal(policy.isAllowedAppInfoRequest({ ...valid, ...patch }), false)
  }
})

test('account IPC validates operation arguments and requires a stored account for switching', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    operation: 'activate',
    args: ['11111111-1111-4111-8111-111111111111'],
    accountExists: true
  }
  assert.equal(policy.isAllowedAccountRequest(base), true)
  for (const patch of [
    { ownerAlive: false },
    { senderMatches: false },
    { mainFrameMatches: false },
    { senderUrl: 'https://mail.google.com/' },
    { operation: 'unknown' },
    { args: [] },
    { args: [42] },
    { args: ['../other-session'] },
    { accountExists: false }
  ]) {
    assert.equal(policy.isAllowedAccountRequest({ ...base, ...patch }), false)
  }
  assert.equal(
    policy.isAllowedAccountRequest({ ...base, operation: 'add', args: [], accountExists: false }),
    true
  )
  assert.equal(
    policy.isAllowedAccountRequest({ ...base, operation: 'retry', args: [], accountExists: true }),
    true
  )
  assert.equal(
    policy.isAllowedAccountRequest({ ...base, operation: 'retry', args: [], accountExists: false }),
    false
  )
  assert.equal(
    policy.isAllowedAccountRequest({ ...base, operation: 'remove', accountExists: true }),
    true
  )
  assert.equal(
    policy.isAllowedAccountRequest({ ...base, operation: 'move', args: [base.args[0], 0] }),
    true
  )
  for (const displayName of ['Personal', null]) {
    assert.equal(
      policy.isAllowedAccountRequest({
        ...base,
        operation: 'setDisplayName',
        args: [base.args[0], displayName]
      }),
      true
    )
  }
  assert.equal(
    policy.isAllowedAccountRequest({
      ...base,
      operation: 'setColor',
      args: [base.args[0], 'green']
    }),
    true
  )
  assert.equal(
    policy.isAllowedAccountRequest({
      ...base,
      operation: 'setNotificationsEnabled',
      args: [base.args[0], false]
    }),
    true
  )
  for (const patch of [
    { operation: 'setDefault', args: [base.args[0]] },
    { operation: 'setColor', args: [base.args[0], 'red'] },
    { operation: 'setColor', args: [base.args[0]] },
    { operation: 'setColor', args: [base.args[0], 'green', 'extra'] },
    { operation: 'setColor', args: ['../other-session', 'green'] },
    { operation: 'setColor', args: [base.args[0], 'green'], accountExists: false },
    { operation: 'setNotificationsEnabled', args: [base.args[0], true, 'extra'] },
    { operation: 'setNotificationsEnabled', args: [base.args[0], 'false'] },
    { operation: 'setNotificationsEnabled', args: [base.args[0], false], accountExists: false },
    { operation: 'move', args: [base.args[0], '1'] },
    { operation: 'move', args: [base.args[0], 0.5] },
    { operation: 'move', args: [base.args[0]] },
    { operation: 'move', args: [base.args[0], 0], accountExists: false },
    { operation: 'setDisplayName', args: [base.args[0], '  '] },
    { operation: 'setDisplayName', args: [base.args[0], 'x'.repeat(81)] },
    { operation: 'setDisplayName', args: [base.args[0], 'unknown@example.com', 'extra'] },
    { operation: 'setDisplayName', args: ['../other-session', 'Personal'] },
    { operation: 'setDisplayName', args: [base.args[0], null], accountExists: false },
    { operation: 'recordWebIdentityEmail', args: [base.args[0], 'user@example.com'] }
  ]) {
    assert.equal(policy.isAllowedAccountRequest({ ...base, ...patch }), false)
  }
  for (const patch of [
    { operation: 'remove', args: ['../other-session'], accountExists: true },
    { operation: 'remove', accountExists: false },
    { operation: 'remove', args: [base.args[0], 'extra'], accountExists: true }
  ]) {
    assert.equal(policy.isAllowedAccountRequest({ ...base, ...patch }), false)
  }
})

test('Google connection IPC accepts only known operations for the live owner main frame and one existing UUID', () => {
  const valid = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    operation: 'connect',
    args: ['11111111-1111-4111-8111-111111111111'],
    accountExists: true
  }
  assert.equal(policy.isAllowedGoogleConnectionRequest(valid), true)
  for (const patch of [
    { ownerAlive: false },
    { senderMatches: false },
    { mainFrameMatches: false },
    { senderUrl: 'https://mail.google.com/' },
    { operation: 'activate' },
    { operation: {} },
    { args: [] },
    { args: ['11111111-1111-4111-8111-111111111111', 'extra'] },
    { args: ['../other-session'] },
    { accountExists: false }
  ]) {
    assert.equal(policy.isAllowedGoogleConnectionRequest({ ...valid, ...patch }), false)
  }
  for (const operation of ['get', 'connect', 'cancel', 'disconnect']) {
    assert.equal(policy.isAllowedGoogleConnectionRequest({ ...valid, operation }), true)
  }
})

test('notification IPC validates empty snapshot queries and existing account action UUIDs', () => {
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    operation: 'recover',
    args: ['11111111-1111-4111-8111-111111111111'],
    accountExists: true
  }
  assert.equal(policy.isAllowedNotificationRequest(base), true)
  assert.equal(policy.isAllowedNotificationRequest({ ...base, operation: 'get', args: [] }), true)
  for (const patch of [
    { operation: 'unknown' },
    { args: [] },
    { args: ['not-an-id'] },
    { accountExists: false },
    { senderMatches: false },
    { senderUrl: 'https://mail.google.com/' },
    { operation: 'get', args: ['11111111-1111-4111-8111-111111111111'] }
  ])
    assert.equal(policy.isAllowedNotificationRequest({ ...base, ...patch }), false)
})

test('settings IPC allows get with no args and update with one valid patch from the owner frame', () => {
  const rendererUrl = 'file:///app/out/renderer/index.html'
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl
  }
  assert.equal(isAllowedSettingsRequest({ ...base, operation: 'get', args: [] }), true)
  assert.equal(
    isAllowedSettingsRequest({ ...base, operation: 'update', args: [{ theme: 'dark' }] }),
    true
  )
  assert.equal(isAllowedSettingsRequest({ ...base, operation: 'panel', args: [true] }), true)
  assert.equal(
    isAllowedSettingsRequest({ ...base, operation: 'status-strip', args: [false] }),
    true
  )
  assert.equal(
    isAllowedSettingsRequest({ ...base, operation: 'ai-mail-panel', args: [true] }),
    true
  )
  for (const request of [
    { ...base, operation: 'get', args: [{}] },
    { ...base, operation: 'update', args: [] },
    { ...base, operation: 'update', args: [{ theme: 'neon' }] },
    { ...base, operation: 'update', args: [{ theme: 'dark' }, {}] },
    { ...base, operation: 'reset', args: [] },
    { ...base, operation: 'panel', args: ['true'] },
    { ...base, operation: 'panel', args: [] },
    { ...base, operation: 'status-strip', args: ['false'] },
    { ...base, operation: 'status-strip', args: [false, true] },
    { ...base, operation: 'ai-mail-panel', args: ['true'] },
    { ...base, operation: 'ai-mail-panel', args: [] },
    { ...base, operation: 'ai-mail-panel', args: [true, false] },
    { ...base, senderMatches: false, operation: 'get', args: [] },
    { ...base, senderUrl: 'https://mail.google.com/', operation: 'get', args: [] }
  ]) {
    assert.equal(isAllowedSettingsRequest(request), false)
  }
})

test('clipboard writes require owner-frame text bounded by UTF-8 bytes', () => {
  const rendererUrl = 'file:///app/out/renderer/index.html'
  const base = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: ['short revision']
  }
  assert.equal(isAllowedClipboardWriteRequest(base), true)
  for (const request of [
    { ...base, args: [] },
    { ...base, args: [42] },
    { ...base, args: ['x'.repeat(140_000)] },
    { ...base, senderMatches: false },
    { ...base, mainFrameMatches: false },
    { ...base, ownerAlive: false },
    { ...base, senderUrl: 'https://mail.google.com/' }
  ])
    assert.equal(isAllowedClipboardWriteRequest(request), false)
})
