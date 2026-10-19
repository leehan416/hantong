import type { GmailMailAlert } from './gmail-mail-alerts'

// No `icon`: macOS draws it as a right-side content image, not the app icon. The left icon comes
// from the app bundle (Electron's in dev, Hantong's in a packaged build).
export function buildMailNotificationOptions(alert: GmailMailAlert): {
  title: string
  body: string
} {
  return { title: alert.title, body: alert.body }
}
