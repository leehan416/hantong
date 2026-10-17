/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createSettingsStore, isSettingsPatch, parseSettings } = loadTypeScript(
  new URL('../src/main/settings-store.ts', import.meta.url)
)
const defaults = { version: 1, language: 'system', theme: 'system', closeAction: 'hide' }

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-settings-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a missing or corrupt settings file starts from defaults without being overwritten', () => {
  withDirectory((directory) => {
    assert.deepEqual({ ...createSettingsStore(directory).get() }, defaults)
    writeFileSync(join(directory, 'settings.json'), '{not json')
    assert.deepEqual({ ...createSettingsStore(directory).get() }, defaults)
    assert.equal(readFileSync(join(directory, 'settings.json'), 'utf8'), '{not json')
  })
})

test('stored settings keep valid fields and fall back per field for invalid ones', () => {
  assert.deepEqual(
    { ...parseSettings({ version: 1, language: 'ko', theme: 'neon', closeAction: 'quit' }) },
    { ...defaults, language: 'ko', closeAction: 'quit' }
  )
  assert.deepEqual({ ...parseSettings({ version: 2, language: 'ko' }) }, defaults)
})

test('updates merge, persist across restarts and reject unknown fields or values', () => {
  withDirectory((directory) => {
    const store = createSettingsStore(directory)
    assert.deepEqual({ ...store.update({ theme: 'dark' }) }, { ...defaults, theme: 'dark' })
    store.update({ language: 'en', closeAction: 'quit' })
    assert.deepEqual(
      { ...createSettingsStore(directory).get() },
      { version: 1, language: 'en', theme: 'dark', closeAction: 'quit' }
    )
    assert.throws(() => store.update({ theme: 'neon' }), { message: 'Invalid settings' })
    assert.equal(store.get().theme, 'dark')
  })
})

test('settings patches must name at least one known field with an allowed value', () => {
  for (const patch of [{ theme: 'light' }, { language: 'ko', closeAction: 'hide' }]) {
    assert.equal(isSettingsPatch(patch), true)
  }
  for (const patch of [
    {},
    null,
    [],
    'dark',
    { version: 2 },
    { theme: 'Light' },
    { theme: 'dark', extra: true },
    { closeAction: 1 }
  ]) {
    assert.equal(isSettingsPatch(patch), false)
  }
})
