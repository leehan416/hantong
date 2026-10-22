import type { GmailHistorySyncResult } from './gmail-history-sync'
import type { GmailMessageSummary } from './gmail-metadata'

export interface GmailMailAlert {
  readonly accountId: string
  readonly title: string
  readonly body: string
}

export interface GmailMailAlertsDependencies {
  readonly accountExists: (accountId: string) => boolean
  readonly korean: () => boolean
  readonly readUnreadCount: (accountId: string) => Promise<number>
  readonly readSummary: (accountId: string, messageId: string) => Promise<GmailMessageSummary>
  readonly notify: (alert: GmailMailAlert) => void
  readonly setBadge: (total: number) => void
  readonly onDiagnostic?: (event: {
    readonly type: 'unread.success' | 'unread.failure' | 'unread.applied' | 'unread.stale'
    readonly accountId: string
    readonly count?: number
  }) => void
}

// Beyond this many arrivals in one pass, the rest collapse into one summary alert.
const MAX_DETAILED_ALERTS = 3

export function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/.exec(from)
  if (!match) return from.trim()
  return match[1].trim() || match[2].trim()
}

export function createGmailMailAlerts(dependencies: GmailMailAlertsDependencies): {
  onChanges(accountId: string, result: GmailHistorySyncResult): Promise<void>
  remove(accountId: string): void
  unreadCounts(): ReadonlyMap<string, number>
} {
  const counts = new Map<string, number>()
  // Bumped on remove so results that finish afterwards are dropped.
  const generations = new Map<string, number>()
  const report = (
    event: Parameters<NonNullable<GmailMailAlertsDependencies['onDiagnostic']>>[0]
  ): void => {
    try {
      dependencies.onDiagnostic?.(event)
    } catch {
      // Diagnostics cannot change unread or notification behavior.
    }
  }

  const publishBadge = (): void => {
    let total = 0
    for (const count of counts.values()) total += count
    dependencies.setBadge(total)
  }
  const current = (accountId: string, generation: number): boolean =>
    (generations.get(accountId) ?? 0) === generation && dependencies.accountExists(accountId)

  const refreshUnread = async (accountId: string, generation: number): Promise<void> => {
    let count: number
    try {
      count = await dependencies.readUnreadCount(accountId)
    } catch {
      report({ type: 'unread.failure', accountId })
      return
    }
    report({ type: 'unread.success', accountId })
    if (!current(accountId, generation)) {
      report({ type: 'unread.stale', accountId })
      return
    }
    counts.set(accountId, count)
    publishBadge()
    report({ type: 'unread.applied', accountId, count })
  }

  const alertArrivals = async (
    accountId: string,
    messageIds: readonly string[],
    generation: number
  ): Promise<void> => {
    const korean = dependencies.korean()
    const detailed = messageIds.slice(0, MAX_DETAILED_ALERTS)
    const summaries = await Promise.allSettled(
      detailed.map((id) => dependencies.readSummary(accountId, id))
    )
    if (!current(accountId, generation)) return
    for (const summary of summaries) {
      // Skip mail already read or archived elsewhere, and lookups that failed.
      if (summary.status !== 'fulfilled' || !summary.value.unreadInInbox) continue
      const sender = senderName(summary.value.from)
      dependencies.notify({
        accountId,
        title: sender || (korean ? '새 메일' : 'New mail'),
        body: summary.value.subject.trim() || (korean ? '(제목 없음)' : '(no subject)')
      })
    }
    const rest = messageIds.length - detailed.length
    if (rest > 0) {
      dependencies.notify({
        accountId,
        title: korean ? '새 메일' : 'New mail',
        body: korean ? `새 메일 ${rest}통이 더 있습니다` : `${rest} more new messages`
      })
    }
  }

  return {
    async onChanges(accountId, result): Promise<void> {
      const generation = generations.get(accountId) ?? 0
      const work = [refreshUnread(accountId, generation)]
      // A baseline is the first look at the mailbox; existing mail never notifies.
      if (result.kind === 'changes' && result.addedMessageIds.length) {
        work.push(alertArrivals(accountId, result.addedMessageIds, generation))
      }
      await Promise.all(work)
    },
    remove(accountId): void {
      generations.set(accountId, (generations.get(accountId) ?? 0) + 1)
      if (counts.delete(accountId)) publishBadge()
    },
    unreadCounts(): ReadonlyMap<string, number> {
      return counts
    }
  }
}
