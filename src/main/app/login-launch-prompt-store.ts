import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface LoginLaunchPromptState {
  readonly version: 1
  readonly seen: true
}

export function createLoginLaunchPromptStore(directory: string): {
  isSeen: () => boolean
  markSeen: () => void
} {
  const file = join(directory, 'login-launch-prompt.json')
  let seen = false
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'version' in value &&
      value.version === 1 &&
      'seen' in value &&
      value.seen === true
    )
      seen = true
  } catch {
    // Missing or corrupt metadata means the confirmation has not been answered yet.
  }

  function persist(state: LoginLaunchPromptState): void {
    const temporary = join(directory, `.login-launch-prompt-${randomUUID()}.tmp`)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(state), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx'
      })
      renameSync(temporary, file)
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        // Keep the write failure as the useful error.
      }
      throw new Error('Unable to save login launch prompt state')
    }
  }

  return {
    isSeen: () => seen,
    markSeen: (): void => {
      if (seen) return
      persist({ version: 1, seen: true })
      seen = true
    }
  }
}
