import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAccountId } from './account-state'

export interface GmailSyncStore {
  read(accountId: string): string | null
  write(accountId: string, historyId: string): void
  delete(accountId: string): void
}

interface CursorEntry {
  accountId: string
  historyId: string
}

interface CursorState {
  version: 1
  cursors: CursorEntry[]
}

const INVALID_DATA = 'Invalid Gmail sync data'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function validateAccountId(accountId: unknown): asserts accountId is string {
  if (!isAccountId(accountId)) throw new Error(INVALID_DATA)
}

function parseState(value: unknown): CursorState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.cursors)) {
    throw new Error(INVALID_DATA)
  }
  const entries: CursorEntry[] = []
  const seen = new Set<string>()
  const savedEntries: unknown[] = value.cursors
  for (const entry of savedEntries) {
    if (
      !isRecord(entry) ||
      !isAccountId(entry.accountId) ||
      !isHistoryId(entry.historyId) ||
      seen.has(entry.accountId) ||
      Object.keys(entry).length !== 2
    ) {
      throw new Error(INVALID_DATA)
    }
    seen.add(entry.accountId)
    entries.push({ accountId: entry.accountId, historyId: entry.historyId })
  }
  if (Object.keys(value).length !== 2) throw new Error(INVALID_DATA)
  return { version: 1, cursors: entries }
}

export function createGmailSyncStore(directory: string): GmailSyncStore {
  const file = join(directory, 'gmail-sync.json')

  function load(): CursorState {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { version: 1, cursors: [] }
      }
      // Filesystem errors can expose local paths; keep load failures generic.
      // eslint-disable-next-line preserve-caught-error
      throw new Error('Unable to load Gmail sync data')
    }
    try {
      return parseState(JSON.parse(content) as unknown)
    } catch {
      throw new Error('Unable to load Gmail sync data')
    }
  }

  let state = load()

  function save(next: CursorState): void {
    const temporary = join(directory, `.gmail-sync-${randomUUID()}.tmp`)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    } catch {
      try {
        rmSync(temporary, { force: true })
      } catch {
        throw new Error('Unable to save Gmail sync data')
      }
      throw new Error('Unable to save Gmail sync data')
    }
    state = next
  }

  return {
    read(accountId) {
      validateAccountId(accountId)
      return state.cursors.find((entry) => entry.accountId === accountId)?.historyId ?? null
    },
    write(accountId, historyId) {
      validateAccountId(accountId)
      if (!isHistoryId(historyId)) throw new Error(INVALID_DATA)
      const cursors = state.cursors.filter((entry) => entry.accountId !== accountId)
      cursors.push({ accountId, historyId })
      save({ version: 1, cursors })
    },
    delete(accountId) {
      validateAccountId(accountId)
      if (!state.cursors.some((entry) => entry.accountId === accountId)) return
      save({ version: 1, cursors: state.cursors.filter((entry) => entry.accountId !== accountId) })
    }
  }
}
