/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const diagnostics = loadTypeScript(new URL('../src/main/main-diagnostics.ts', import.meta.url))

test('diagnostic records allowlisted fields and anonymous stable account aliases', () => {
  const events = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => 123,
    sink: { append: (line) => events.push(JSON.parse(line)) }
  })
  recorder.record({ type: 'relay.ready', accountId: 'a1b2c3d4-e5f6-4789-8abc-123456789abc' })
  recorder.record({
    type: 'relay.failure',
    accountId: 'a1b2c3d4-e5f6-4789-8abc-123456789abc',
    code: 'unknown'
  })
  assert.deepEqual(events[0], { at: 123, type: 'relay.ready', account: 'account-1' })
  assert.deepEqual(events[1], {
    at: 123,
    type: 'relay.failure',
    account: 'account-1',
    code: 'unknown'
  })
  assert.deepEqual(
    { ...recorder.snapshot().accounts['account-1'].relay },
    {
      readyAt: 123,
      lastFailure: 'unknown'
    }
  )
})

test('diagnostics never serialize arbitrary errors, tokens, emails, or mail identifiers', () => {
  const lines = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => 123,
    sink: { append: (line) => lines.push(line) }
  })
  recorder.record({
    type: 'sync.failure',
    accountId: 'a1b2c3d4-e5f6-4789-8abc-123456789abc',
    error: 'SECRET_TOKEN ann@example.test subject body m-123'
  })
  assert.equal(lines.join('').includes('SECRET_TOKEN'), false)
  assert.equal(lines.join('').includes('ann@example.test'), false)
  assert.equal(lines.join('').includes('subject body'), false)
  assert.equal(lines.join('').includes('m-123'), false)
})

test('diagnostic snapshots and retained events stay bounded', () => {
  const lines = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => 123,
    sink: { append: (line) => lines.push(line) },
    maxEvents: 2,
    maxAccounts: 2
  })
  for (const accountId of [
    'a1b2c3d4-e5f6-4789-8abc-123456789abc',
    'b1b2c3d4-e5f6-4789-8abc-123456789abc',
    'c1b2c3d4-e5f6-4789-8abc-123456789abc'
  ]) {
    recorder.record({ type: 'sync.null', accountId })
  }
  assert.equal(recorder.snapshot().events.length, 2)
  assert.equal(Object.keys(recorder.snapshot().accounts).length, 2)
})

test('file sink rotates within the configured byte bound', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-diagnostics-'))
  try {
    const sink = diagnostics.createRotatingDiagnosticsSink({
      path: join(directory, 'diagnostics.jsonl'),
      maxBytes: 100,
      maxFiles: 2
    })
    await sink.append('x'.repeat(70) + '\n')
    await sink.append('y'.repeat(70) + '\n')
    await sink.append('z'.repeat(70) + '\n')
    await sink.flush()
    assert.ok((await stat(join(directory, 'diagnostics.jsonl'))).size <= 100)
    assert.ok((await stat(join(directory, 'diagnostics.jsonl.1'))).size <= 100)
    assert.match(await readFile(join(directory, 'diagnostics.jsonl'), 'utf8'), /^z/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('file sink drops oversized UTF-8 records without writing malformed data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hantong-diagnostics-'))
  try {
    const path = join(directory, 'diagnostics.jsonl')
    const sink = diagnostics.createRotatingDiagnosticsSink({ path, maxBytes: 100 })
    await sink.append('界'.repeat(40) + '\n')
    await sink.flush()
    await assert.rejects(readFile(path, 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('recorder isolates sink and observer exceptions', () => {
  const recorder = diagnostics.createMainDiagnostics({
    now: () => 123,
    sink: {
      append: () => {
        throw new Error('secret')
      }
    },
    observe: () => {
      throw new Error('secret')
    }
  })
  assert.doesNotThrow(() =>
    recorder.record({ type: 'relay.ready', accountId: 'a1b2c3d4-e5f6-4789-8abc-123456789abc' })
  )
  assert.equal(recorder.snapshot().events.length, 1)
})

test('failed diagnostic reads preserve last successful timestamps and sanitize malformed fields', () => {
  let now = 100
  const lines = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => now,
    sink: { append: (line) => lines.push(line) }
  })
  const id = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
  recorder.record({ type: 'sync.success', accountId: id, kind: 'changes' })
  now = 200
  recorder.record({ type: 'sync.failure', accountId: id })
  recorder.record({ type: 'relay.failure', accountId: id, code: 'unknown' })
  const output = lines.join('')
  assert.equal(output.includes('SECRET diagnostic detail'), false)
  assert.equal(output.includes('unknown'), true)
  assert.equal(JSON.stringify(recorder.snapshot()).includes('SECRET diagnostic detail'), false)
  assert.deepEqual(
    { ...recorder.snapshot().accounts['account-1'].sync },
    {
      at: 200,
      outcome: 'failure',
      lastSuccessAt: 100,
      kind: 'changes'
    }
  )
})

test('heartbeats throttle persisted records while snapshots keep the latest heartbeat', () => {
  let now = 0
  const lines = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => now,
    sink: { append: (line) => lines.push(line) },
    heartbeatThrottleMs: 1000
  })
  const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
  recorder.record({ type: 'relay.heartbeat', accountId })
  now = 500
  recorder.record({ type: 'relay.heartbeat', accountId })
  now = 1200
  recorder.record({ type: 'relay.heartbeat', accountId })
  assert.equal(lines.length, 2)
  assert.equal(recorder.snapshot().accounts['account-1'].relay.heartbeatAt, 1200)
})

test('watch and relay snapshots retain last success through retry and blocked attempts', () => {
  let now = 100
  const recorder = diagnostics.createMainDiagnostics({ now: () => now })
  const accountId = 'a1b2c3d4-e5f6-4789-8abc-123456789abc'
  recorder.record({ type: 'watch.renewed', accountId, expiresAt: 500 })
  recorder.record({ type: 'relay.session', accountId, outcome: 'success' })
  now = 200
  recorder.record({ type: 'watch.retry', accountId, nextAttemptAt: 300 })
  recorder.record({ type: 'relay.session', accountId, outcome: 'failure', code: 'network_error' })
  const account = recorder.snapshot().accounts['account-1']
  assert.equal(account.watch.expiresAt, 500)
  assert.equal(account.watch.lastSuccessAt, 100)
  assert.equal(account.watch.outcome, 'retry')
  assert.equal(account.session.lastSuccessAt, 100)
  assert.equal(account.session.outcome, 'failure')
})

test('bootstrap records work without an account alias and reject unknown stage values', () => {
  const lines = []
  const recorder = diagnostics.createMainDiagnostics({
    now: () => 100,
    sink: { append: (line) => lines.push(line) }
  })
  recorder.record({ type: 'relay.bootstrap', stage: 'config', outcome: 'enabled' })
  recorder.record({ type: 'relay.bootstrap', stage: 'config-secret', outcome: 'enabled' })
  recorder.record({
    type: 'relay.bootstrap',
    stage: { toString: () => 'config' },
    outcome: { toString: () => 'enabled' }
  })
  assert.equal(lines.length, 1)
  assert.deepEqual(JSON.parse(lines[0]), {
    at: 100,
    type: 'relay.bootstrap',
    stage: 'config',
    outcome: 'enabled'
  })
})
