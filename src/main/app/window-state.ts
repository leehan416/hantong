import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Rect
  maximized: boolean
}

const MIN_WIDTH = 640
const MIN_HEIGHT = 480
// A window needs at least this much of its title bar area on some display to be grabbable.
const MIN_VISIBLE = 80

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isSafeInteger(value[key]))
  )
}

export function parseWindowState(value: unknown): WindowState | null {
  if (!isRecord(value) || !isRect(value.bounds) || typeof value.maximized !== 'boolean') return null
  return { bounds: { ...value.bounds }, maximized: value.maximized }
}

// Keep the saved size within the display it lands on; drop the position if no display shows it.
export function fitWindowBounds(saved: Rect, workAreas: readonly Rect[]): Rect | null {
  for (const area of workAreas) {
    const visibleWidth =
      Math.min(saved.x + saved.width, area.x + area.width) - Math.max(saved.x, area.x)
    const titleBarVisible = saved.y >= area.y && saved.y < area.y + area.height - MIN_VISIBLE / 2
    if (visibleWidth >= MIN_VISIBLE && titleBarVisible) {
      return {
        x: saved.x,
        y: saved.y,
        width: Math.max(MIN_WIDTH, Math.min(saved.width, area.width)),
        height: Math.max(MIN_HEIGHT, Math.min(saved.height, area.height))
      }
    }
  }
  return null
}

export function createWindowStateStore(directory: string): {
  read(): WindowState | null
  write(state: WindowState): void
} {
  const file = join(directory, 'window-state.json')
  return {
    read(): WindowState | null {
      try {
        return parseWindowState(JSON.parse(readFileSync(file, 'utf8')))
      } catch {
        return null
      }
    },
    write(state): void {
      const temporary = `${file}.tmp`
      try {
        writeFileSync(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 })
        renameSync(temporary, file)
      } catch {
        // Losing the last window position is harmless; never block closing on it.
      }
    }
  }
}
