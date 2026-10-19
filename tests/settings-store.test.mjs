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
const defaults = {
  version: 1,
  language: 'system',
  theme: 'system',
  closeAction: 'hide',
  hideGmailLogo: false,
  hideHeaderButtons: false,
  hideSidePanel: false,
  hideStoragePromo: false,
  accountSelectorPosition: 'top',
  sidebarCollapsed: false
}

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
  assert.deepEqual(
    {
      ...parseSettings({
        version: 1,
        language: 'ko',
        accountSelectorPosition: 'center',
        sidebarCollapsed: 'yes',
        accentColor: 'red'
      })
    },
    { ...defaults, language: 'ko' }
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
      { ...defaults, language: 'en', theme: 'dark', closeAction: 'quit' }
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

test('Gmail cleanup toggles are booleans, off by default, and persist individually', () => {
  withDirectory((directory) => {
    const store = createSettingsStore(directory)
    store.update({ hideHeaderButtons: true, hideSidePanel: true })
    store.update({ hideSidePanel: false })
    assert.deepEqual(
      { ...createSettingsStore(directory).get() },
      { ...defaults, hideHeaderButtons: true }
    )
  })
  assert.equal(isSettingsPatch({ hideGmailLogo: true }), true)
  for (const patch of [
    { hideGmailLogo: 'true' },
    { hideHeaderButtons: 1 },
    { hideSidePanel: null }
  ]) {
    assert.equal(isSettingsPatch(patch), false)
  }
  assert.equal(parseSettings({ version: 1, hideStoragePromo: 'yes' }).hideStoragePromo, false)
})

test('navigation preferences accept fixed values and persist across restarts', () => {
  withDirectory((directory) => {
    const store = createSettingsStore(directory)
    for (const accountSelectorPosition of ['top', 'bottom', 'left', 'right']) {
      assert.equal(isSettingsPatch({ accountSelectorPosition }), true)
      store.update({ accountSelectorPosition })
    }
    assert.equal(isSettingsPatch({ sidebarCollapsed: false }), true)
    assert.equal(isSettingsPatch({ sidebarCollapsed: true }), true)
    store.update({ sidebarCollapsed: false })
    store.update({ sidebarCollapsed: true })
    assert.deepEqual(
      { ...createSettingsStore(directory).get() },
      {
        ...defaults,
        accountSelectorPosition: 'right',
        sidebarCollapsed: true
      }
    )
    for (const patch of [
      { accountSelectorPosition: 'center' },
      // The accent preference was removed; account colors carry identity instead.
      { accentColor: 'blue' },
      { sidebarCollapsed: 'true' }
    ]) {
      assert.equal(isSettingsPatch(patch), false)
      assert.throws(() => store.update(patch), { message: 'Invalid settings' })
    }
  })
})

test('a saved hideGemini choice carries over to the top-bar extras toggle', () => {
  assert.equal(parseSettings({ version: 1, hideGemini: true }).hideHeaderButtons, true)
  assert.equal(parseSettings({ version: 1, hideGemini: false }).hideHeaderButtons, false)
  assert.equal(
    parseSettings({ version: 1, hideGemini: true, hideHeaderButtons: false }).hideHeaderButtons,
    false
  )
})
