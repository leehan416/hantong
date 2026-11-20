import { appendFile, mkdir, rename, stat, truncate } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { dirname } from 'node:path'
import type { MainDiagnosticSink } from './main-diagnostics-types'

export interface RotatingDiagnosticsSinkOptions {
  readonly path: string
  readonly maxBytes?: number
  readonly maxFiles?: number
}

export function createRotatingDiagnosticsSink(
  options: RotatingDiagnosticsSinkOptions
): MainDiagnosticSink {
  const maxBytes = Math.max(1, options.maxBytes ?? 128 * 1024)
  const maxFiles = Math.max(1, Math.min(5, options.maxFiles ?? 3))
  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const append = (line: string): Promise<void> => {
    if (pending >= 128 || Buffer.byteLength(line, 'utf8') > maxBytes) return Promise.resolve()
    pending += 1
    queue = queue
      .then(async () => {
        await mkdir(dirname(options.path), { recursive: true })
        let size: number
        try {
          size = (await stat(options.path)).size
        } catch {
          size = 0
        }
        const bytes = Buffer.byteLength(line, 'utf8')
        if (size > 0 && size + bytes > maxBytes) {
          for (let index = maxFiles - 2; index >= 1; index -= 1) {
            const source = `${options.path}.${index}`
            const destination = `${options.path}.${index + 1}`
            try {
              await rename(source, destination)
            } catch {
              // Missing older rotation files are expected.
            }
          }
          if (maxFiles === 1) {
            await truncate(options.path, 0).catch(() => undefined)
          } else {
            try {
              await rename(options.path, `${options.path}.1`)
            } catch {
              await truncate(options.path, 0).catch(() => undefined)
            }
          }
        }
        await appendFile(options.path, line, { encoding: 'utf8', mode: 0o600 })
      })
      .catch(() => undefined)
      .finally(() => {
        pending -= 1
      })
    return queue
  }
  return { append, flush: () => queue }
}
