import { createHash } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/* eslint @typescript-eslint/explicit-function-return-type: "off" */

const version = '0.167.1'
const target = 'aarch64-apple-darwin'
const archiveSha256 = '4c97fbdafba21e172254107939489691195f34712cf0cb31293e5e21be8f5bfa'
const executableSha256 = 'ebabe5f0d79145a9e61274ce9ecf7c02c9021b7b04bfa59b7e61ad4461c32b0b'
const archiveName = `codex-${target}.tar.gz`
const archiveUrl = `https://github.com/openai/codex/releases/download/rust-v${version}/${archiveName}`
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(repoRoot, 'resources/codex-runtime/bin/codex')

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

async function main() {
  const localArchiveArg = process.argv[2]
  const temp = await mkdtemp(join(tmpdir(), 'hantong-codex-provision-'))
  try {
    const archive = join(temp, archiveName)
    let bytes
    if (localArchiveArg) {
      const localStat = await lstat(resolve(localArchiveArg))
      if (!localStat.isFile() || localStat.isSymbolicLink())
        throw new Error('Local Codex archive must be a regular file')
      bytes = await readFile(resolve(localArchiveArg))
    } else {
      let url = archiveUrl
      let downloaded
      for (let redirects = 0; redirects <= 5; redirects += 1) {
        downloaded = await fetch(url, { redirect: 'manual' })
        if (![301, 302, 303, 307, 308].includes(downloaded.status)) break
        if (redirects === 5) throw new Error('Too many Codex download redirects')
        const location = downloaded.headers.get('location')
        if (!location) throw new Error('Codex download redirect missing location')
        const redirected = new URL(location, url)
        if (redirected.protocol !== 'https:' || redirected.username || redirected.password)
          throw new Error('Unsafe Codex download redirect')
        url = redirected.href
      }
      if (!downloaded?.ok) throw new Error(`Codex download failed with HTTP ${downloaded?.status}`)
      bytes = Buffer.from(await downloaded.arrayBuffer())
    }
    if (sha256(bytes) !== archiveSha256) throw new Error('Codex archive SHA-256 mismatch')
    await writeFile(archive, bytes, { mode: 0o600, flag: 'wx' })

    const listing = run('tar', ['-tzvf', archive])
    const entries = listing.trim().split('\n')
    if (
      entries.length !== 1 ||
      !entries[0].endsWith(' codex-aarch64-apple-darwin') ||
      !entries[0].startsWith('-rwxr-xr-x')
    )
      throw new Error('Unexpected or unsafe Codex archive contents')

    const extracted = join(temp, 'codex-aarch64-apple-darwin')
    run('tar', ['-xzf', archive, '-C', temp, 'codex-aarch64-apple-darwin'])
    const stat = await lstat(extracted)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error('Extracted Codex entry is not a regular file')
    const executable = await readFile(extracted)
    if (sha256(executable) !== executableSha256)
      throw new Error('Codex executable SHA-256 mismatch')

    await mkdir(dirname(destination), { recursive: true })
    const staged = `${destination}.tmp-${process.pid}`
    try {
      const destinationStat = await lstat(dirname(destination))
      if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink())
        throw new Error('Unsafe Codex destination directory')
      await copyFile(extracted, staged, 1)
      await chmod(staged, 0o755)
      if (sha256(await readFile(staged)) !== executableSha256)
        throw new Error('Staged Codex executable SHA-256 mismatch')
      const existing = await lstat(destination).catch((error) => {
        if (error.code === 'ENOENT') return null
        throw error
      })
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new Error('Unsafe existing Codex destination')
      await rename(staged, destination)
    } finally {
      await rm(staged, { force: true })
    }
    console.log(`Provisioned Codex ${version} (${target})`)
    console.log(`Archive SHA-256: ${archiveSha256}`)
    console.log(`Executable SHA-256: ${executableSha256}`)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Codex provisioning failed')
  process.exitCode = 1
})
