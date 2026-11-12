import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  inspectArchiveListing,
  sha256,
  validateRedirect
} from '../scripts/provision-codex-runtime.mjs'

test('archive listing accepts only one executable at the expected root path', () => {
  inspectArchiveListing(
    '-rwxr-xr-x  0 runner staff 271011440 Nov 11 04:17 codex-aarch64-apple-darwin\n'
  )
  for (const unsafe of [
    '-rwxr-xr-x 0 runner staff 1 Nov 11 04:17 ../codex-aarch64-apple-darwin\n',
    'lrwxrwxrwx 0 runner staff 1 Nov 11 04:17 codex-aarch64-apple-darwin -> /tmp/payload\n',
    '-rwxr-xr-x 0 runner staff 1 Nov 11 04:17 codex-aarch64-apple-darwin\n-rw-r--r-- 0 a b 0 now extra\n'
  ]) {
    assert.throws(() => inspectArchiveListing(unsafe), /Unexpected or unsafe/)
  }
})

test('Codex download redirects are bounded to HTTPS GitHub release asset hosts', () => {
  assert.equal(
    validateRedirect(
      'https://github.com/openai/codex/releases/download/a',
      'https://release-assets.githubusercontent.com/asset',
      0
    ),
    'https://release-assets.githubusercontent.com/asset'
  )
  for (const [url, hops] of [
    ['http://github.com/release', 0],
    ['https://untrusted.example/payload', 0],
    ['https://user:secret@github.com/payload', 0],
    ['https://github.com/payload', 5]
  ]) {
    assert.throws(() => validateRedirect('https://github.com/start', url, hops))
  }
})

test('SHA-256 helper returns digest over exact bytes', () => {
  assert.equal(
    sha256(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
  )
})
