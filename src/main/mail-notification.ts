import type { GmailMailAlert } from './gmail-mail-alerts'

export function buildMailNotificationOptions(
  alert: GmailMailAlert,
  iconPath: string
): { title: string; body: string; icon: string } {
  return { title: alert.title, body: alert.body, icon: iconPath }
}
