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
  onReconnect
}: {
  accessState: AccountAccessUiState
  access: AccountAccessUiState['state']
  busy: boolean
  googleOperation: GoogleConnectionUiState['operation']
  text: AppMessages
  onRetry: () => void
  onCancel: () => void
  onReconnect: () => void
}): React.JSX.Element {
  return (
    <main className="access-gate" aria-labelledby="access-gate-title">
      <section className="access-gate-content" aria-live="polite" aria-busy={accessState.loading}>
        <h1 id="access-gate-title">
          {accessState.readFailed
            ? text.accessErrorTitle
            : access?.status === 'required'
              ? text.accessRequiredTitle
              : access?.status === 'error'
                ? text.accessErrorTitle
                : text.accessCheckingTitle}
        </h1>
        <p role="status">
          {accessState.readFailed
            ? text.apiCheckError
            : access?.connectionStatus === 'connecting'
              ? text.accessConnecting
              : access?.status === 'required'
                ? text.accessRequired
                : access?.status === 'error'
                  ? text.accessError
                  : text.accessChecking}
        </p>
        {accessState.readFailed ? (
          <button
            className="access-gate-action"
            type="button"
            disabled={busy || accessState.loading}
            onClick={onRetry}
          >
            {text.accessRetry}
          </button>
        ) : access?.connectionStatus === 'connecting' ? (
          <button
            className="access-gate-action"
            type="button"
            disabled={googleOperation === 'cancelling'}
            onClick={onCancel}
          >
            {googleOperation === 'cancelling' ? text.apiCancelling : text.accessCancel}
          </button>
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
