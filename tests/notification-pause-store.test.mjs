/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const sourceUrl = new URL('../src/main/notification-pause-store.ts', import.meta.url)
const defaults = { version: 1, pausedUntil: null, notifyAfter: 0 }

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-notification-pause-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('missing or malformed pause state uses defaults without overwriting the file', () => {
  withDirectory((directory) => {
    const { createNotificationPauseStore } = loadTypeScript(sourceUrl)
    assert.deepEqual({ ...createNotificationPauseStore(directory).getState() }, defaults)
    const malformed = JSON.stringify({ version: 1, pausedUntil: 'tomorrow', notifyAfter: 0 })
    writeFileSync(join(directory, 'notification-pause.json'), malformed)
    assert.deepEqual({ ...createNotificationPauseStore(directory).getState() }, defaults)
    assert.equal(readFileSync(join(directory, 'notification-pause.json'), 'utf8'), malformed)
  })
})

test('pause deadline and cutoff persist across store restarts and early resume advances cutoff', () => {
  withDirectory((directory) => {
    const { createNotificationPauseStore } = loadTypeScript(sourceUrl)
    const store = createNotificationPauseStore(directory)
    assert.deepEqual(
      { ...store.setPause(10_000) },
      {
        version: 1,
        pausedUntil: 10_000,
        notifyAfter: 10_000
      }
    )
    const reopened = createNotificationPauseStore(directory)
    assert.deepEqual(
      { ...reopened.getState() },
      {
        version: 1,
        pausedUntil: 10_000,
        notifyAfter: 10_000
      }
    )
    assert.deepEqual(
      { ...reopened.resume(7_000) },
      {
        version: 1,
        pausedUntil: null,
        notifyAfter: 7_000
      }
    )
    assert.deepEqual(
      { ...createNotificationPauseStore(directory).getState() },
      {
        version: 1,
        pausedUntil: null,
        notifyAfter: 7_000
      }
    )
  })
})

test('expired deadlines retain their notification cutoff after restart', () => {
  withDirectory((directory) => {
    writeFileSync(
      join(directory, 'notification-pause.json'),
      JSON.stringify({ version: 1, pausedUntil: 5_000, notifyAfter: 5_000 })
    )
    const { createNotificationPauseStore } = loadTypeScript(sourceUrl)
    assert.deepEqual(
      { ...createNotificationPauseStore(directory).getState() },
      {
        version: 1,
        pausedUntil: 5_000,
        notifyAfter: 5_000
      }
    )
  })
})

test('invalid timestamps and failed atomic writes do not alter saved or in-memory state', () => {
  withDirectory((directory) => {
    const { createNotificationPauseStore } = loadTypeScript(sourceUrl)
    const store = createNotificationPauseStore(directory)
    for (const timestamp of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, 8_640_000_000_000_001, NaN]) {
      assert.throws(() => store.setPause(timestamp), /Invalid notification pause/)
      assert.throws(() => store.resume(timestamp), /Invalid notification pause/)
    }
    writeFileSync(join(directory, 'notification-pause.json'), JSON.stringify(defaults))
    const failingFs = {
      ...fs,
      renameSync: () => {
        throw new Error('disk failure')
      }
    }
    const broken = loadTypeScript(sourceUrl, { 'node:fs': failingFs }).createNotificationPauseStore(
      directory
    )
    assert.throws(() => broken.setPause(10_000), /Unable to save notification pause/)
    assert.deepEqual({ ...broken.getState() }, defaults)
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, 'notification-pause.json'), 'utf8')),
      defaults
    )
  })
})
