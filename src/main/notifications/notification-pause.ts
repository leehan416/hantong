import type { NotificationPauseState } from './notification-pause-store'

export type NotificationPauseChoice = '30m' | '1h' | 'tomorrow'

export interface NotificationPauseSnapshot {
  readonly paused: boolean
  readonly pausedUntil: number | null
  readonly notifyAfter: number
  readonly revision: number
}

interface NotificationPauseStore {
  getState: () => NotificationPauseState
  setPause: (pausedUntil: number) => NotificationPauseState
  resume: (notifyAfter: number) => NotificationPauseState
}

export function nextLocalMidnight(now: number): number {
  if (!isValidTimestamp(now)) throw new Error('Invalid notification pause clock')
  const tomorrow = new Date(now)
  tomorrow.setHours(24, 0, 0, 0)
  const deadline = tomorrow.getTime()
  if (!isValidTimestamp(deadline) || deadline <= now) {
    throw new Error('Invalid notification pause deadline')
  }
  return deadline
}

function isValidTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  )
}

function readNow(now: () => number): number {
  const value = now()
  if (!isValidTimestamp(value)) throw new Error('Invalid notification pause clock')
  return value
}

export function createNotificationPauseController(dependencies: {
  readonly store: NotificationPauseStore
  readonly now: () => number
  readonly setTimeout?: typeof setTimeout
  readonly clearTimeout?: typeof clearTimeout
  readonly onChange: (snapshot: NotificationPauseSnapshot) => void
}): {
  snapshot: () => NotificationPauseSnapshot
  pauseFor: (choice: NotificationPauseChoice) => NotificationPauseSnapshot
  resumeNow: () => NotificationPauseSnapshot
  refresh: () => NotificationPauseSnapshot
  dispose: () => void
} {
  const setTimer = dependencies.setTimeout ?? setTimeout
  const clearTimer = dependencies.clearTimeout ?? clearTimeout
  let revision = 0
  let previousPaused: boolean
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  const readState = (): NotificationPauseState => dependencies.store.getState()
  const isPausedAt = (state: NotificationPauseState, now: number): boolean =>
    state.pausedUntil !== null && state.pausedUntil > now

  const snapshot = (): NotificationPauseSnapshot => {
    const state = readState()
    const now = readNow(dependencies.now)
    return {
      paused: isPausedAt(state, now),
      pausedUntil: state.pausedUntil,
      notifyAfter: state.notifyAfter,
      revision
    }
  }

  const clearScheduledTimer = (): void => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  const armTimer = (): void => {
    clearScheduledTimer()
    if (disposed) return
    const state = readState()
    if (state.pausedUntil === null) return
    const remaining = state.pausedUntil - readNow(dependencies.now)
    if (remaining <= 0) return
    const delay = Math.min(60_000, remaining)
    timer = setTimer(() => {
      timer = undefined
      refresh()
    }, delay)
  }

  const publish = (force = false): NotificationPauseSnapshot => {
    const next = snapshot()
    const changed = previousPaused !== next.paused
    previousPaused = next.paused
    armTimer()
    if (force || changed) dependencies.onChange(next)
    return next
  }

  function refresh(): NotificationPauseSnapshot {
    if (disposed) return snapshot()
    return publish()
  }

  previousPaused = snapshot().paused
  armTimer()

  return {
    snapshot,
    pauseFor(choice): NotificationPauseSnapshot {
      const now = readNow(dependencies.now)
      const pausedUntil =
        choice === '30m'
          ? now + 30 * 60_000
          : choice === '1h'
            ? now + 60 * 60_000
            : choice === 'tomorrow'
              ? nextLocalMidnight(now)
              : null
      if (pausedUntil === null || !isValidTimestamp(pausedUntil) || pausedUntil <= now) {
        throw new Error('Invalid notification pause duration')
      }
      dependencies.store.setPause(pausedUntil)
      revision += 1
      return publish(true)
    },
    resumeNow(): NotificationPauseSnapshot {
      const now = readNow(dependencies.now)
      dependencies.store.resume(now)
      revision += 1
      return publish(true)
    },
    refresh,
    dispose(): void {
      disposed = true
      clearScheduledTimer()
    }
  }
}

export function createNotificationPauseMenuActions(
  controller: Pick<ReturnType<typeof createNotificationPauseController>, 'pauseFor' | 'resumeNow'>,
  onFailure: (error: unknown) => void
): {
  pause30: () => void
  pause60: () => void
  pauseTomorrow: () => void
  resume: () => void
} {
  const run = (action: () => unknown): void => {
    try {
      action()
    } catch (error) {
      onFailure(error)
    }
  }
  return {
    pause30: () => run(() => controller.pauseFor('30m')),
    pause60: () => run(() => controller.pauseFor('1h')),
    pauseTomorrow: () => run(() => controller.pauseFor('tomorrow')),
    resume: () => run(() => controller.resumeNow())
  }
}
