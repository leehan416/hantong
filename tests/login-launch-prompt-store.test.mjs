/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JS types. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const sourceUrl = new URL('../src/main/login-launch-prompt-store.ts', import.meta.url)

function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-login-prompt-'))
  try {
    run(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('missing or corrupt prompt metadata starts unseen without overwriting it', () => {
  withDirectory((directory) => {
    const { createLoginLaunchPromptStore } = loadTypeScript(sourceUrl)
    assert.equal(createLoginLaunchPromptStore(directory).isSeen(), false)
    const file = join(directory, 'login-launch-prompt.json')
    writeFileSync(file, '{corrupt')
    assert.equal(createLoginLaunchPromptStore(directory).isSeen(), false)
    assert.equal(readFileSync(file, 'utf8'), '{corrupt')
  })
})

test('answered prompt persists across store recreation', () => {
  withDirectory((directory) => {
    const { createLoginLaunchPromptStore } = loadTypeScript(sourceUrl)
    const store = createLoginLaunchPromptStore(directory)
    store.markSeen()
    assert.equal(createLoginLaunchPromptStore(directory).isSeen(), true)
  })
})

test('failed atomic persistence is surfaced and leaves prompt unseen', () => {
  withDirectory((directory) => {
    const failingFs = {
      ...fs,
      renameSync: () => {
        throw new Error('disk failure')
      }
    }
    const { createLoginLaunchPromptStore } = loadTypeScript(sourceUrl, {
      'node:fs': failingFs
    })
    const store = createLoginLaunchPromptStore(directory)
    assert.throws(() => store.markSeen(), /Unable to save login launch prompt state/)
    assert.equal(store.isSeen(), false)
  })
})
