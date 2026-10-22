import { buildGmailCleanupCss } from './gmail-cleanup'
import type { AppSettings } from '../shared/settings'

export function createGmailCleanupRuntime(settings: () => AppSettings | undefined): {
  apply(contents: Electron.WebContents): void
} {
  // Each Gmail document gets at most one cleanup stylesheet; calls are chained so toggles cannot
  // interleave and leave a stale stylesheet behind.
  const gmailCleanupKeys = new WeakMap<Electron.WebContents, string>()
  const gmailCleanupQueue = new WeakMap<Electron.WebContents, Promise<void>>()

  function isGmailDocument(contents: Electron.WebContents): boolean {
    try {
      return new URL(contents.getURL()).origin === 'https://mail.google.com'
    } catch {
      return false
    }
  }

  function apply(contents: Electron.WebContents): void {
    const run = async (): Promise<void> => {
      if (contents.isDestroyed()) return
      const previous = gmailCleanupKeys.get(contents)
      gmailCleanupKeys.delete(contents)
      // A key from an earlier document is already gone; removing it is a harmless no-op.
      if (previous) await contents.removeInsertedCSS(previous).catch(() => undefined)
      const currentSettings = settings()
      const css = currentSettings ? buildGmailCleanupCss(currentSettings) : ''
      if (!css || contents.isDestroyed() || !isGmailDocument(contents)) return
      gmailCleanupKeys.set(contents, await contents.insertCSS(css))
    }
    const next = (gmailCleanupQueue.get(contents) ?? Promise.resolve()).then(run).catch(() => {
      // CSS that fails to apply leaves Gmail's original interface in place.
    })
    gmailCleanupQueue.set(contents, next)
  }

  return { apply }
}
