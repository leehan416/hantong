import type { AccountAccessUiState, GoogleConnectionUiState } from './google-connection-controller'
import type { AppMessages } from './app-messages'

export function AccountAccessGate({
  accessState,
  access,
  busy,
  googleOperation,
  text,
  onRetry,
  onCancel,
  onReconnect,
  onReopen
}: {
  accessState: AccountAccessUiState
  access: AccountAccessUiState['state']
  busy: boolean
  googleOperation: GoogleConnectionUiState['operation']
  text: AppMessages
  onRetry: () => void
  onCancel: () => void
  onReconnect: () => void
  onReopen: () => void
}): React.JSX.Element {
  const checking = accessState.loading || access?.status === 'checking'
  const actualConnecting = access?.connectionStatus === 'connecting'
  const readFailed = accessState.readFailed && !checking

  return (
    <main className="access-gate" aria-labelledby="access-gate-title">
      <section className="access-gate-content" aria-live="polite" aria-busy={checking}>
        <h1 id="access-gate-title">
          {checking
            ? text.accessCheckingTitle
            : readFailed
              ? text.accessErrorTitle
              : access?.status === 'required'
                ? text.accessRequiredTitle
                : access?.status === 'error'
                  ? text.accessErrorTitle
                  : text.accessCheckingTitle}
        </h1>
        <p role="status">
          {checking
            ? actualConnecting
              ? text.accessConnecting
              : text.accessChecking
            : readFailed
              ? text.apiCheckError
              : access?.connectionStatus === 'connecting'
                ? text.accessConnecting
                : access?.status === 'required'
                  ? text.accessRequired
                  : access?.status === 'error'
                    ? text.accessError
                    : text.accessChecking}
        </p>
        {checking && !actualConnecting ? null : readFailed ? (
          <button
            className="access-gate-action"
            type="button"
            disabled={busy || accessState.loading}
            onClick={onRetry}
          >
            {text.accessRetry}
          </button>
        ) : actualConnecting ? (
          <div className="access-gate-actions">
            <button
              className="access-gate-action"
              type="button"
              disabled={googleOperation === 'cancelling' || googleOperation === 'restarting'}
              onClick={onCancel}
            >
              {googleOperation === 'cancelling' ? text.apiCancelling : text.accessCancel}
            </button>
            <button
              className="access-gate-action"
              type="button"
              disabled={googleOperation === 'cancelling' || googleOperation === 'restarting'}
              onClick={onReopen}
            >
              {googleOperation === 'restarting' ? text.accessReopening : text.accessReopen}
            </button>
          </div>
        ) : access?.status === 'required' || access?.status === 'error' ? (
          <button
            className="access-gate-action"
            type="button"
            disabled={busy || googleOperation !== null}
            onClick={onReconnect}
          >
            {googleOperation === 'connecting' ? text.apiConnecting : text.apiReconnect}
          </button>
        ) : null}
      </section>
    </main>
  )
}
