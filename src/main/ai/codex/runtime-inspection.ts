import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { CodexRuntimePin } from './codex-runtime-pin'

const CODEX_RUNTIME_VERSION = '0.167.1'
const CODEX_RUNTIME_TARGET = 'aarch64-apple-darwin'

export type InspectedRuntime = {
  executablePath?: string
  executableRoot?: string
  runtimeDirectory?: string
}

type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number }

function validPackagedDirectory(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  const modeBits = typeof stat.mode === 'bigint' ? Number(stat.mode & 0o7777n) : stat.mode & 0o7777
  return stat.isDirectory() && !stat.isSymbolicLink() && (modeBits & 0o022) === 0
}

function validPackagedExecutable(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  const modeBits = typeof stat.mode === 'bigint' ? Number(stat.mode & 0o7777n) : stat.mode & 0o7777
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    (modeBits & 0o111) !== 0 &&
    (modeBits & 0o022) === 0
  )
}

function sameFileIdentity(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>> | FileIdentity
): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs
  )
}

async function hashPackagedExecutable(
  path: string,
  expectedStat: Awaited<ReturnType<typeof lstat>>
): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const openStat = await handle.stat()
    if (!sameFileIdentity(openStat, expectedStat) || !validPackagedExecutable(openStat))
      throw new Error('product_owned_executable_changed')
    const digest = createHash('sha256')
    const stream = handle.createReadStream({ autoClose: false })
    for await (const chunk of stream) digest.update(chunk)
    const finalStat = await handle.stat()
    if (!sameFileIdentity(finalStat, expectedStat))
      throw new Error('product_owned_executable_changed')
    return digest.digest('hex')
  } finally {
    await handle.close()
  }
}

export function inspectRuntime(resourcesDirectory: string | undefined): InspectedRuntime {
  const executablePath = resourcesDirectory
    ? join(resolve(resourcesDirectory), 'codex-runtime', 'bin', 'codex')
    : undefined
  const executableRoot = executablePath ? dirname(executablePath) : undefined
  return {
    executablePath,
    executableRoot,
    runtimeDirectory: executableRoot ? dirname(executableRoot) : undefined
  }
}

export function hasTrustedRuntimePin(runtimePin: CodexRuntimePin): boolean {
  return (
    runtimePin.version === CODEX_RUNTIME_VERSION &&
    runtimePin.target === CODEX_RUNTIME_TARGET &&
    typeof runtimePin.executableSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(runtimePin.executableSha256)
  )
}

export async function verifyPackagedExecutable(
  resourcesDirectory: string,
  runtimeDirectory: string,
  executableRoot: string,
  executablePath: string,
  runtimePin: CodexRuntimePin,
  assertCurrent: () => void
): Promise<FileIdentity> {
  const [resourceStat, runtimeStat, executableDirectoryStat, executableStat] = await Promise.all([
    lstat(resolve(resourcesDirectory)),
    lstat(runtimeDirectory),
    lstat(executableRoot),
    lstat(executablePath)
  ])
  assertCurrent()
  if (
    !validPackagedDirectory(resourceStat) ||
    !validPackagedDirectory(runtimeStat) ||
    !validPackagedDirectory(executableDirectoryStat) ||
    !validPackagedExecutable(executableStat)
  )
    throw new Error('product_owned_executable_invalid')
  const executableIdentity: FileIdentity = {
    dev: executableStat.dev,
    ino: executableStat.ino,
    size: executableStat.size,
    mtimeMs: executableStat.mtimeMs
  }
  const digest = await hashPackagedExecutable(executablePath, executableStat)
  assertCurrent()
  if (digest !== runtimePin.executableSha256) throw new Error('product_owned_executable_invalid')
  return executableIdentity
}

export async function verifyExecutableUnchanged(
  executablePath: string,
  executableIdentity: FileIdentity
): Promise<void> {
  const beforeSpawnStat = await lstat(executablePath)
  if (
    !validPackagedExecutable(beforeSpawnStat) ||
    !sameFileIdentity(beforeSpawnStat, executableIdentity)
  )
    throw new Error('product_owned_executable_changed')
}
