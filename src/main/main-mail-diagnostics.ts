import type { createMainDiagnostics } from './main-diagnostics'
import type { createNotificationConnectionController } from './notification-connection-controller'
import type { createGmailMailAlerts } from './gmail-mail-alerts'
import type { createGmailWatchManager } from './gmail-watch-manager'
import type { createGmailRelaySync } from './gmail-relay-sync'
import type { createRelayRuntime } from './relay-runtime'
import { notificationRelayFailureCode } from './notification-connection-controller'
import { relayDiagnosticCode } from './main-diagnostics'

type NotificationController = ReturnType<typeof createNotificationConnectionController>
type Diagnostics = ReturnType<typeof createMainDiagnostics>
type UnreadEvent = NonNullable<Parameters<typeof createGmailMailAlerts>[0]['onDiagnostic']>
type WatchEvent = NonNullable<Parameters<typeof createGmailWatchManager>[0]['onDiagnostic']>
type HistoryEvent = NonNullable<Parameters<typeof createGmailRelaySync>[0]['onDiagnostic']>
type RelayEvent = NonNullable<Parameters<typeof createRelayRuntime>[0]['onDiagnostic']>

export function createMainMailDiagnostics(dependencies: {
  readonly diagnostics: Diagnostics
  readonly notifications: () => NotificationController | null
}): {
  onUnread(event: Parameters<UnreadEvent>[0]): void
  onWatch(event: Parameters<WatchEvent>[0]): void
  onHistory(event: Parameters<HistoryEvent>[0]): void
  onRelay(event: Parameters<RelayEvent>[0]): void
} {
  function onUnread(event: Parameters<UnreadEvent>[0]): void {
    if (event.type === 'unread.success' || event.type === 'unread.applied')
      dependencies.notifications()?.event({
        type: 'unread',
        accountId: event.accountId,
        outcome: 'success'
      })
    else if (event.type === 'unread.failure')
      dependencies.notifications()?.event({
        type: 'unread',
        accountId: event.accountId,
        outcome: 'failure'
      })
    if (event.type === 'unread.applied' && event.count !== undefined) {
      dependencies.diagnostics.record({
        type: event.type,
        accountId: event.accountId,
        count: event.count
      })
    } else if (event.type === 'unread.success') {
      dependencies.diagnostics.record({ type: event.type, accountId: event.accountId })
    } else if (event.type === 'unread.failure') {
      dependencies.diagnostics.record({ type: event.type, accountId: event.accountId })
    } else if (event.type === 'unread.stale') {
      dependencies.diagnostics.record({ type: event.type, accountId: event.accountId })
    }
  }

  function onWatch(event: Parameters<WatchEvent>[0]): void {
    if (event.status === 'renewed')
      dependencies.notifications()?.event({
        type: 'watch',
        accountId: event.accountId,
        outcome: 'renewed'
      })
    else if (event.status === 'retry')
      dependencies.notifications()?.event({
        type: 'watch',
        accountId: event.accountId,
        outcome: 'retry'
      })
    else if (event.status === 'blocked')
      dependencies.notifications()?.event({
        type: 'watch',
        accountId: event.accountId,
        outcome: 'blocked',
        ...(event.code ? { code: event.code } : {})
      })
    else if (event.status === 'cancelled')
      dependencies.notifications()?.event({
        type: 'watch',
        accountId: event.accountId,
        outcome: 'cancelled'
      })
    if (event.status === 'renewed' && event.expiresAt !== undefined) {
      dependencies.diagnostics.record({
        type: 'watch.renewed',
        accountId: event.accountId,
        expiresAt: event.expiresAt
      })
    } else if (event.status === 'retry') {
      dependencies.diagnostics.record({
        type: 'watch.retry',
        accountId: event.accountId,
        nextAttemptAt: event.nextAttemptAt
      })
    } else if (event.status === 'blocked') {
      dependencies.diagnostics.record({
        type: 'watch.blocked',
        accountId: event.accountId,
        nextAttemptAt: null
      })
    } else if (event.status === 'cancelled') {
      dependencies.diagnostics.record({
        type: 'watch.cancelled',
        accountId: event.accountId,
        nextAttemptAt: null
      })
    } else if (event.status === 'deferred') {
      dependencies.diagnostics.forget(event.accountId)
    }
  }

  function onHistory(event: Parameters<HistoryEvent>[0]): void {
    if (event.type === 'sync.success')
      dependencies.notifications()?.event({
        type: 'history',
        accountId: event.accountId,
        outcome: 'success'
      })
    else if (event.type === 'sync.null')
      dependencies.notifications()?.event({
        type: 'history',
        accountId: event.accountId,
        outcome: 'null'
      })
    else if (event.type === 'sync.failure')
      dependencies.notifications()?.event({
        type: 'history',
        accountId: event.accountId,
        outcome: 'failure'
      })
    dependencies.diagnostics.record(event)
  }

  function onRelay(event: Parameters<RelayEvent>[0]): void {
    if (event.type === 'bootstrap') {
      const outcome = event.outcome
      if (event.stage === 'credentials') {
        if (outcome === 'missing')
          dependencies.notifications()?.event({
            type: 'credentials',
            accountId: event.accountId,
            outcome: 'missing'
          })
        else if (outcome === 'success')
          dependencies.notifications()?.event({
            type: 'credentials',
            accountId: event.accountId,
            outcome: 'read_success'
          })
        else if (outcome === 'failure' || outcome === 'unavailable')
          dependencies.notifications()?.event({
            type: 'credentials',
            accountId: event.accountId,
            outcome: 'read_failure'
          })
      } else if (event.stage === 'credential_write') {
        if (outcome === 'success')
          dependencies.notifications()?.event({
            type: 'credential_write',
            accountId: event.accountId,
            outcome: 'success'
          })
        else if (outcome === 'failure')
          dependencies.notifications()?.event({
            type: 'credential_write',
            accountId: event.accountId,
            outcome: 'failure'
          })
        else if (outcome === 'skipped')
          dependencies.notifications()?.event({
            type: 'credential_write',
            accountId: event.accountId,
            outcome: 'skipped'
          })
      } else if (event.stage === 'session_start') {
        dependencies.notifications()?.event({
          type: 'session',
          accountId: event.accountId,
          outcome: 'started'
        })
      } else if (
        (event.stage === 'proof_id_token' || event.stage === 'proof_nonce') &&
        outcome === 'missing'
      ) {
        dependencies.notifications()?.event({
          type: 'session',
          accountId: event.accountId,
          outcome: 'blocked'
        })
      }
      dependencies.diagnostics.record({
        type: 'relay.bootstrap',
        accountId: event.accountId,
        stage: event.stage,
        outcome: event.outcome,
        ...(event.code ? { code: relayDiagnosticCode(event.code) } : {})
      })
      return
    }
    if (event.type === 'session' || event.type === 'refresh') {
      const outcome =
        event.outcome === 'success'
          ? 'success'
          : event.outcome === 'blocked'
            ? 'blocked'
            : 'failure'
      dependencies.notifications()?.event({
        type: 'session',
        accountId: event.accountId,
        outcome,
        ...(event.code ? { code: notificationRelayFailureCode(event.code) } : {})
      })
    } else if (event.type === 'transport') {
      const outcome =
        event.transport?.type === 'ready'
          ? 'ready'
          : event.transport?.type === 'closed'
            ? 'closed'
            : event.transport?.type === 'failure' || event.code
              ? 'failure'
              : undefined
      if (outcome)
        dependencies.notifications()?.event({
          type: 'transport',
          accountId: event.accountId,
          outcome
        })
    } else if (event.type === 'reconnect' && event.outcome === 'blocked') {
      dependencies.notifications()?.event({
        type: 'session',
        accountId: event.accountId,
        outcome: 'blocked',
        ...(event.code ? { code: notificationRelayFailureCode(event.code) } : {})
      })
    }
    if (event.type === 'transport') {
      const transport = event.transport
      if (!transport) {
        if (event.code) {
          dependencies.diagnostics.record({
            type: 'relay.failure',
            accountId: event.accountId,
            code: relayDiagnosticCode(event.code)
          })
        }
        return
      }
      if (transport.type === 'ready')
        dependencies.diagnostics.record({ type: 'relay.ready', accountId: event.accountId })
      else if (transport.type === 'receive')
        dependencies.diagnostics.record({ type: 'relay.receive', accountId: event.accountId })
      else if (transport.type === 'heartbeat')
        dependencies.diagnostics.record({ type: 'relay.heartbeat', accountId: event.accountId })
      else if (transport.type === 'closed')
        dependencies.diagnostics.record({ type: 'relay.closed', accountId: event.accountId })
      else return
      return
    }
    if (event.type === 'reconnect') {
      if (event.outcome === 'blocked') {
        dependencies.diagnostics.record({
          type: 'relay.failure',
          accountId: event.accountId,
          code: relayDiagnosticCode(event.code)
        })
        return
      }
      if (event.outcome !== 'retry') return
      dependencies.diagnostics.record({
        type: 'relay.retry',
        accountId: event.accountId,
        code: relayDiagnosticCode(event.code),
        delayMs: event.delayMs ?? 0
      })
      return
    }
    if (!event.outcome) return
    const type = event.type === 'session' ? 'relay.session' : 'relay.refresh'
    dependencies.diagnostics.record({
      type,
      accountId: event.accountId,
      outcome: event.outcome ?? 'failure',
      ...(event.code ? { code: relayDiagnosticCode(event.code) } : {})
    })
  }

  return { onUnread, onWatch, onHistory, onRelay }
}
