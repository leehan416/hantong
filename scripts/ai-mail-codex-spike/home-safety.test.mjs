/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these safety tests as JavaScript. */
import assert from 'node:assert/strict'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertPrivateDirectoryStat,
  ensureCanaryFile,
  ensureNoLocalIoProfile,
  prepareHome
} from './harness.mjs'

const HOME_MARKER = '.hantong-codex-isolation'
const HOME_MARKER_CONTENT = 'hantong-codex-isolation-v1\n'
const CANARY_FILE_NAME = 'read-denial-canary.txt'
const CANARY_FILE_CONTENT = 'HANTONG_OWNED_CANARY'
const LEGACY_CONFIG = `default_permissions = "hantong-no-local-io"

[permissions.hantong-no-local-io.filesystem]
":root" = "deny"
":minimal" = "deny"

[permissions.hantong-no-local-io.network]
enabled = false
`

async function makeTestRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'hantong-codex-home-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('rejects external home overrides without changing the target', async (t) => {
  const root = await makeTestRoot(t)
  const externalHome = join(root, 'external-home')
  await mkdir(externalHome, { mode: 0o700 })
  const configPath = join(externalHome, 'config.toml')
  await writeFile(configPath, 'user-config = true\n', { mode: 0o600 })
  await chmod(externalHome, 0o755)

  await assert.rejects(prepareHome({ baseDir: root, override: externalHome }), /override/i)
  assert.equal((await lstat(externalHome)).mode & 0o777, 0o755)
  assert.equal(await readFile(configPath, 'utf8'), 'user-config = true\n')
})

test('creates a marked private home and reuses it without changing its permissions', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = await prepareHome({ baseDir: root, override: null })
  const before = await lstat(codeHome)

  assert.equal(before.mode & 0o777, 0o700)
  assert.equal((await lstat(join(codeHome, HOME_MARKER))).mode & 0o777, 0o600)
  assert.equal(await readFile(join(codeHome, HOME_MARKER), 'utf8'), HOME_MARKER_CONTENT)
  assert.equal(await prepareHome({ baseDir: root, override: null }), codeHome)
  assert.equal((await lstat(codeHome)).mode & 0o777, before.mode & 0o777)
})

test('reuses its exact isolated config across harness runs without rewriting it', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = await prepareHome({ baseDir: root, override: null })
  await ensureNoLocalIoProfile(codeHome)
  const configPath = join(codeHome, 'config.toml')
  const config = await readFile(configPath, 'utf8')

  assert.equal(await ensureNoLocalIoProfile(codeHome), join(codeHome, 'empty-workspace'))
  assert.equal(await readFile(configPath, 'utf8'), config)
})

test('fails closed on an unmarked existing home without chmod or config replacement', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  await mkdir(codeHome, { mode: 0o700 })
  const configPath = join(codeHome, 'config.toml')
  await writeFile(configPath, 'keep-this = true\n', { mode: 0o600 })
  await assert.rejects(prepareHome({ baseDir: root, override: null }), /isolated home/i)
  assert.equal((await lstat(codeHome)).mode & 0o777, 0o700)
  assert.equal(await readFile(configPath, 'utf8'), 'keep-this = true\n')
})

test('rejects unsafe existing directory permissions without changing them', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  await mkdir(codeHome, { mode: 0o700 })
  await chmod(codeHome, 0o755)

  await assert.rejects(prepareHome({ baseDir: root, override: null }), /permissions are unsafe/i)
  assert.equal((await lstat(codeHome)).mode & 0o777, 0o755)
})

test('rejects symlinked homes and mismatched directory owners', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  const target = join(root, 'target')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, codeHome)

  await assert.rejects(prepareHome({ baseDir: root, override: null }), /not a directory/i)
  const targetStat = await lstat(target)
  assert.throws(
    () => assertPrivateDirectoryStat(targetStat, targetStat.uid + 1),
    /owner does not match/i
  )
})

test('rejects a symlinked ownership marker without following it', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  const targetMarker = join(root, 'target-marker')
  await mkdir(codeHome, { mode: 0o700 })
  await writeFile(targetMarker, HOME_MARKER_CONTENT, { mode: 0o600 })
  await symlink(targetMarker, join(codeHome, HOME_MARKER))

  await assert.rejects(prepareHome({ baseDir: root, override: null }), /regular file/i)
  assert.equal(await readFile(targetMarker, 'utf8'), HOME_MARKER_CONTENT)
})

test('rejects an invalid ownership marker without rewriting it', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  const markerPath = join(codeHome, HOME_MARKER)
  await mkdir(codeHome, { mode: 0o700 })
  await writeFile(markerPath, 'not-the-harness-marker\n', { mode: 0o600 })

  await assert.rejects(prepareHome({ baseDir: root, override: null }), /marker is invalid/i)
  assert.equal(await readFile(markerPath, 'utf8'), 'not-the-harness-marker\n')
})

test('does not rewrite a recognized older config in an existing home', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = join(root, 'hantong-codex-isolated-v1')
  await mkdir(codeHome, { mode: 0o700 })
  await writeFile(join(codeHome, HOME_MARKER), HOME_MARKER_CONTENT, {
    mode: 0o600,
    flag: 'wx'
  })
  const configPath = join(codeHome, 'config.toml')
  await writeFile(configPath, LEGACY_CONFIG, { mode: 0o600 })

  await assert.rejects(ensureNoLocalIoProfile(codeHome), /unrelated settings/i)
  assert.equal(await readFile(configPath, 'utf8'), LEGACY_CONFIG)
})

test('creates and safely reuses the expected synthetic canary', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = await prepareHome({ baseDir: root, override: null })
  const canaryPath = await ensureCanaryFile(codeHome)
  const before = await lstat(canaryPath)

  assert.equal(canaryPath, join(codeHome, CANARY_FILE_NAME))
  assert.equal(before.mode & 0o777, 0o600)
  assert.equal(await readFile(canaryPath, 'utf8'), CANARY_FILE_CONTENT)
  assert.equal(await ensureCanaryFile(codeHome), canaryPath)
  assert.equal((await lstat(canaryPath)).ino, before.ino)
})

test('rejects a canary symlink without modifying its target', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = await prepareHome({ baseDir: root, override: null })
  const target = join(root, 'canary-target')
  await writeFile(target, 'preserve-target\n', { mode: 0o600 })
  await symlink(target, join(codeHome, CANARY_FILE_NAME))

  await assert.rejects(ensureCanaryFile(codeHome), /regular file/i)
  assert.equal(await readFile(target, 'utf8'), 'preserve-target\n')
})

test('rejects unsafe canary content and permissions without replacing the file', async (t) => {
  const root = await makeTestRoot(t)
  const codeHome = await prepareHome({ baseDir: root, override: null })
  const canaryPath = join(codeHome, CANARY_FILE_NAME)
  await writeFile(canaryPath, 'preserve-existing-content\n', { mode: 0o600 })

  await assert.rejects(ensureCanaryFile(codeHome), /content is invalid/i)
  assert.equal(await readFile(canaryPath, 'utf8'), 'preserve-existing-content\n')
  await rm(canaryPath)
  await writeFile(canaryPath, CANARY_FILE_CONTENT, { mode: 0o600 })
  await chmod(canaryPath, 0o644)

  await assert.rejects(ensureCanaryFile(codeHome), /permissions are unsafe/i)
  assert.equal((await lstat(canaryPath)).mode & 0o777, 0o644)
  assert.equal(await readFile(canaryPath, 'utf8'), CANARY_FILE_CONTENT)
})
