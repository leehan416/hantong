import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const HOME_MARKER = '.hantong-codex-isolation'
const HOME_MARKER_CONTENT = 'hantong-codex-isolation-v1\n'
const HOME_NAME = 'hantong-codex-isolated-v1'
const WORKSPACE_NAME = 'empty-workspace'
const PERMISSION_PROFILE = 'hantong-no-local-io'

function validPrivateStat(stat: Awaited<ReturnType<typeof lstat>>, directory: boolean): boolean {
  const uid = process.getuid?.()
  const modeBits = typeof stat.mode === 'bigint' ? Number(stat.mode & 0o7777n) : stat.mode & 0o7777
  return (
    (directory ? stat.isDirectory() : stat.isFile()) &&
    !stat.isSymbolicLink() &&
    Number.isInteger(uid) &&
    stat.uid === uid &&
    modeBits === (directory ? 0o700 : 0o600) &&
    (directory || stat.nlink === 1)
  )
}

async function readPrivateText(path: string): Promise<string> {
  const noFollow = constants.O_NOFOLLOW
  if (!Number.isInteger(noFollow)) throw new Error('safe_file_access_unavailable')
  const pathStat = await lstat(path)
  if (!validPrivateStat(pathStat, false)) throw new Error('unsafe_private_file')
  const handle = await open(path, constants.O_RDONLY | noFollow)
  try {
    const openStat = await handle.stat()
    if (
      !validPrivateStat(openStat, false) ||
      pathStat.dev !== openStat.dev ||
      pathStat.ino !== openStat.ino
    )
      throw new Error('private_file_changed')
    return await handle.readFile('utf8')
  } finally {
    await handle.close()
  }
}

export function isolatedPermissionProfile(): string {
  return PERMISSION_PROFILE
}

export async function prepareIsolatedHome(
  baseDirectory: string
): Promise<{ home: string; workspace: string }> {
  const uid = process.getuid?.()
  await mkdir(baseDirectory, { recursive: true, mode: 0o700 })
  const baseStat = await lstat(baseDirectory)
  if (!validPrivateStat(baseStat, true) || !Number.isInteger(uid))
    throw new Error('unsafe_data_directory')
  const home = join(baseDirectory, HOME_NAME)
  let created = false
  try {
    await mkdir(home, { mode: 0o700 })
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!validPrivateStat(await lstat(home), true)) throw new Error('unsafe_isolated_home')
  const marker = join(home, HOME_MARKER)
  if (created) {
    await writeFile(marker, HOME_MARKER_CONTENT, { mode: 0o600, flag: 'wx' })
  } else if ((await readPrivateText(marker)) !== HOME_MARKER_CONTENT) {
    throw new Error('isolated_home_marker_invalid')
  }
  const workspace = join(home, WORKSPACE_NAME)
  try {
    await mkdir(workspace, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (!validPrivateStat(await lstat(workspace), true)) throw new Error('unsafe_isolated_workspace')
  const entries = await readdir(workspace)
  if (entries.length > 0) throw new Error('isolated_workspace_not_empty')
  const config = `project_root_markers = []\nproject_doc_max_bytes = 0\ndefault_permissions = "${PERMISSION_PROFILE}"\n\n[permissions.${PERMISSION_PROFILE}.workspace_roots]\n${JSON.stringify(workspace)} = true\n\n[permissions.${PERMISSION_PROFILE}.filesystem]\n":root" = "deny"\n":minimal" = "read"\n\n[permissions.${PERMISSION_PROFILE}.filesystem.":workspace_roots"]\n"." = "read"\n\n[permissions.${PERMISSION_PROFILE}.network]\nenabled = false\n`
  const configPath = join(home, 'config.toml')
  let configExists = false
  try {
    await writeFile(configPath, config, { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    configExists = true
  }
  if (configExists && (await readPrivateText(configPath)) !== config)
    throw new Error('isolated_config_already_contains_unrelated_settings')
  if (!validPrivateStat(await lstat(configPath), false)) throw new Error('unsafe_isolated_config')
  return { home, workspace }
}
