import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CLOSE_ACTION_OPTIONS,
  DEFAULT_SETTINGS,
  LANGUAGE_OPTIONS,
  THEME_OPTIONS,
  type AppSettings,
  type AppSettingsPatch
} from '../shared/settings'

const FIELDS = {
  language: LANGUAGE_OPTIONS,
  theme: THEME_OPTIONS,
  closeAction: CLOSE_ACTION_OPTIONS
} as const satisfies Record<keyof AppSettingsPatch, readonly string[]>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOption(options: readonly string[], value: unknown): boolean {
  return typeof value === 'string' && options.includes(value)
}

// Strict: the renderer must send only known fields with known values, and at least one.
export function isSettingsPatch(value: unknown): value is AppSettingsPatch {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length > 0 &&
    keys.every(
      (key) =>
        Object.hasOwn(FIELDS, key) && isOption(FIELDS[key as keyof typeof FIELDS], value[key])
    )
  )
}

// Lenient: preferences are low-stakes, so a bad or partial file falls back per field to defaults.
export function parseSettings(value: unknown): AppSettings {
  if (!isRecord(value) || value.version !== 1) return { ...DEFAULT_SETTINGS }
  const settings: AppSettings = { ...DEFAULT_SETTINGS }
  for (const key of Object.keys(FIELDS) as (keyof typeof FIELDS)[]) {
    if (isOption(FIELDS[key], value[key])) Object.assign(settings, { [key]: value[key] })
  }
  return settings
}

export function createSettingsStore(directory: string): {
  get(): AppSettings
  update(patch: AppSettingsPatch): AppSettings
} {
  const file = join(directory, 'settings.json')
  let settings: AppSettings
  try {
    settings = parseSettings(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // Missing or unreadable file: start from defaults and leave the file until the next save.
    settings = { ...DEFAULT_SETTINGS }
  }

  return {
    get: () => ({ ...settings }),
    update(patch): AppSettings {
      if (!isSettingsPatch(patch)) throw new Error('Invalid settings')
      const next: AppSettings = { ...settings, ...patch, version: 1 }
      const temporary = join(directory, `.settings-${randomUUID()}.tmp`)
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
          // A failed cleanup must not replace the save error.
        }
        throw new Error('Unable to save settings')
      }
      settings = next
      return { ...settings }
    }
  }
}
