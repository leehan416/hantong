import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

export interface NotificationPauseState {
  readonly version: 1
  readonly pausedUntil: number | null
  readonly notifyAfter: number
}

const DEFAULT_STATE: NotificationPauseState = {
  version: 1,
  pausedUntil: null,
  notifyAfter: 0
}
const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_DATE_TIMESTAMP
  )
}

export function parseNotificationPauseState(value: unknown): NotificationPauseState {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.pausedUntil !== null && !isTimestamp(value.pausedUntil)) ||
    !isTimestamp(value.notifyAfter) ||
    (value.pausedUntil !== null && value.notifyAfter !== value.pausedUntil)
  ) {
    return { ...DEFAULT_STATE }
  }
  return {
    version: 1,
    pausedUntil: value.pausedUntil,
    notifyAfter: value.notifyAfter
  }
}

export function createNotificationPauseStore(directory: string): {
  getState: () => NotificationPauseState
  setPause: (pausedUntil: number) => NotificationPauseState
  resume: (notifyAfter: number) => NotificationPauseState
} {
  const file = join(directory, 'notification-pause.json')
  let state: NotificationPauseState
  try {
    state = parseNotificationPauseState(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Missing or malformed low-risk preferences start from defaults until the next save.
    state = { ...DEFAULT_STATE }
  }

  function persist(next: NotificationPauseState): void {
    const temporary = join(directory, `.notification-pause-${randomUUID()}.tmp`)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(next), {
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
      throw new Error('Unable to save notification pause')
    }
  }

  function save(next: NotificationPauseState): NotificationPauseState {
    persist(next)
    state = next
    return { ...state }
  }

  return {
    getState: () => ({ ...state }),
    setPause(pausedUntil): NotificationPauseState {
      if (!isTimestamp(pausedUntil)) throw new Error('Invalid notification pause')
      return save({ version: 1, pausedUntil, notifyAfter: pausedUntil })
    },
    resume(notifyAfter): NotificationPauseState {
      if (!isTimestamp(notifyAfter)) throw new Error('Invalid notification pause')
      return save({ version: 1, pausedUntil: null, notifyAfter })
    }
  }
}
