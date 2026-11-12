import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('mac signing skips only the bundled Codex executable', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const signIgnore = config.match(/^  signIgnore: '(.+)'$/m)?.[1]
  assert.ok(signIgnore, 'mac.signIgnore must remain configured')
  const ignoredPath = new RegExp(signIgnore)
  assert.equal(
    ignoredPath.test('/tmp/Hantong.app/Contents/Resources/codex-runtime/bin/codex'),
    true
  )
  assert.equal(
    ignoredPath.test('/tmp/Hantong.app/Contents/Resources/codex-runtime/bin/other'),
    false
  )
  assert.equal(ignoredPath.test('/tmp/Hantong.app/Contents/MacOS/Hantong'), false)
  assert.match(config, /^  identity: 'Hantong Self Sign'$/m)
})
