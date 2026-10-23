import { Notification } from 'electron'
import type { GmailMailAlert } from './gmail-mail-alerts'
import { buildMailNotificationOptions } from './mail-notification'

export function createNativeMailNotifications(showAccount: (accountId: string) => void): {
  show(alert: GmailMailAlert): void
} {
  // Electron drops click handlers of notifications that get garbage-collected, so keep them alive.
  const shownNotifications = new Set<Notification>()

  function show(alert: GmailMailAlert): void {
    if (!Notification.isSupported()) return
    const notification = new Notification(buildMailNotificationOptions(alert))
    const forget = (): void => {
      shownNotifications.delete(notification)
    }
    notification.on('click', () => {
      forget()
      showAccount(alert.accountId)
    })
    notification.on('close', forget)
    shownNotifications.add(notification)
    notification.show()
  }

  return { show }
}
