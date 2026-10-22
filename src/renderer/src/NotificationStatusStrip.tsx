import type { NotificationRecoveryUiState } from './notification-recovery-controller'
import type { AppMessages } from './app-messages'

export type StatusAction =
  'view-retry' | 'notification-recover' | 'notification-cancel' | 'notification-retry' | null

export function NotificationStatusStrip({
  message,
  action,
  busy,
  recoveryState,
  text,
  onRetry,
  onRecover,
  onCancel,
  onNotificationRetry
}: {
  message: string
  action: StatusAction
  busy: boolean
  recoveryState: NotificationRecoveryUiState
  text: AppMessages
  onRetry: () => void
  onRecover: () => void
  onCancel: () => void
  onNotificationRetry: () => void
}): React.JSX.Element {
  return (
    <div className="status-strip">
      <span className="status-text" role="status" aria-live="polite">
        {message}
      </span>
      {action === 'view-retry' && (
        <button className="retry-button" type="button" disabled={busy} onClick={onRetry}>
          {text.retry}
        </button>
      )}
      {action === 'notification-recover' && (
        <button
          className="retry-button"
          type="button"
          disabled={recoveryState.operation !== null}
          onClick={onRecover}
        >
          {text.notificationRecover}
        </button>
      )}
      {action === 'notification-cancel' && (
        <button
          className="retry-button"
          type="button"
          disabled={recoveryState.operation !== null && recoveryState.operation !== 'recovering'}
          onClick={onCancel}
        >
          {text.notificationCancel}
        </button>
      )}
      {action === 'notification-retry' && (
        <button
          className="retry-button"
          type="button"
          disabled={recoveryState.operation !== null}
          onClick={onNotificationRetry}
        >
          {text.retry}
        </button>
      )}
    </div>
  )
}
