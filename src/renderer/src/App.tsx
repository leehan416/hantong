import { useEffect, useRef, useState } from 'react'
import type { AccountState } from '../../shared/accounts'
import type { AccountViewStatus, AppInfo } from '../../shared/ipc'
import {
  GoogleConnectionController,
  type GoogleConnectionUiState
} from './google-connection-controller'

const messages = {
  ko: {
    wordmark: 'HANTONG',
    add: '계정 추가',
    remove: '계정 삭제',
    welcome: 'Gmail 계정을 추가해 시작하세요.',
    pending: '계정을 불러오는 중…',
    loading: 'Gmail을 불러오는 중…',
    ready: 'Gmail',
    error: 'Gmail을 불러오지 못했습니다.',
    blocked: '허용되지 않은 페이지 이동을 차단했습니다.',
    retry: '다시 시도',
    operationError: '요청을 완료하지 못했습니다. 다시 시도해 주세요.',
    removeError: '계정을 삭제하지 못했습니다. 다시 시도해 주세요.',
    apiLabel: 'API 연결',
    apiChecking: 'API 상태 확인 중…',
    apiCheckError: 'API 연결 상태를 확인하지 못했습니다.',
    apiDisconnected: 'API 연결 안 됨',
    apiConnected: 'API 연결됨',
    apiConnecting: '브라우저에서 인증을 완료해 주세요.',
    apiCancelling: '연결 취소 중…',
    apiDisconnecting: '연결 해제 중…',
    apiReconnect: '다시 연결',
    apiConnect: '연결',
    apiDisconnect: '연결 해제',
    apiCancel: '취소',
    apiFailure: '연결을 완료하지 못했습니다. 다시 시도해 주세요.'
  },
  en: {
    wordmark: 'HANTONG',
    add: 'Add account',
    remove: 'Remove account',
    welcome: 'Add a Gmail account to get started.',
    pending: 'Loading accounts…',
    loading: 'Loading Gmail…',
    ready: 'Gmail',
    error: 'Unable to load Gmail.',
    blocked: 'A page navigation was blocked.',
    retry: 'Retry',
    operationError: 'Unable to complete the request. Please try again.',
    removeError: 'Unable to remove the account. Please try again.',
    apiLabel: 'API connection',
    apiChecking: 'Checking API status…',
    apiCheckError: 'Unable to check API connection status.',
    apiDisconnected: 'API disconnected',
    apiConnected: 'API connected',
    apiConnecting: 'Complete sign-in in your browser.',
    apiCancelling: 'Cancelling connection…',
    apiDisconnecting: 'Disconnecting…',
    apiReconnect: 'Reconnect',
    apiConnect: 'Connect',
    apiDisconnect: 'Disconnect',
    apiCancel: 'Cancel',
    apiFailure: 'Unable to complete the connection. Please try again.'
  }
}

function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [accounts, setAccounts] = useState<AccountState | null>(null)
  const [viewStatus, setViewStatus] = useState<AccountViewStatus | null>(null)
  const [googleState, setGoogleState] = useState<GoogleConnectionUiState>({
    accountId: null,
    status: null,
    loading: false,
    readFailed: false,
    operation: null,
    operationFailed: false
  })
  const googleController = useRef<GoogleConnectionController | null>(null)
  const [busy, setBusy] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [removalFailed, setRemovalFailed] = useState(false)
  const locale = info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en')
  const text = messages[locale]
  const activeAccountId = accounts?.activeAccountId ?? null
  const activeIndex =
    accounts?.accounts.findIndex((account) => account.id === activeAccountId) ?? -1
  const currentStatus = viewStatus?.accountId === activeAccountId ? viewStatus.status : null
  const googleStateMatches = googleState.accountId === activeAccountId
  const googleStatus = googleStateMatches ? googleState.status : null
  const googleOperation = googleStateMatches ? googleState.operation : null
  const accountActionsBusy = busy || googleOperation !== null || googleStatus === 'connecting'

  let googleMessage = text.apiChecking
  if (googleStateMatches && googleState.loading) googleMessage = text.apiChecking
  else if (googleOperation === 'cancelling') googleMessage = text.apiCancelling
  else if (googleOperation === 'disconnecting') googleMessage = text.apiDisconnecting
  else if (googleStateMatches && googleState.readFailed) googleMessage = text.apiCheckError
  else if (googleStateMatches && googleState.operationFailed) googleMessage = text.apiFailure
  else if (googleStatus === 'disconnected') googleMessage = text.apiDisconnected
  else if (googleStatus === 'connected') googleMessage = text.apiConnected
  else if (googleStatus === 'connecting') googleMessage = text.apiConnecting
  else if (googleStatus === 'reconnect_required') googleMessage = text.apiReconnect
  else if (googleStatus === 'error') googleMessage = text.apiFailure

  useEffect(() => {
    const controller = new GoogleConnectionController(window.api, setGoogleState)
    googleController.current = controller
    return () => {
      controller.dispose()
      if (googleController.current === controller) googleController.current = null
    }
  }, [])

  useEffect(() => {
    googleController.current?.selectAccount(activeAccountId)
  }, [activeAccountId])

  useEffect(() => {
    let active = true
    let subscriptionFailed = false
    let unsubscribe = (): void => {}
    try {
      unsubscribe = window.api.onAccountViewStatus((status) => {
        if (active) setViewStatus(status)
      })
    } catch {
      subscriptionFailed = true
    }
    void Promise.resolve()
      .then(() => Promise.all([window.api.getAppInfo(), window.api.getAccounts()]))
      .then(
        ([appInfo, state]) => {
          if (!active) return
          setInfo(appInfo)
          setAccounts(state)
          if (subscriptionFailed) setOperationFailed(true)
        },
        () => {
          if (active) setOperationFailed(true)
        }
      )
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  async function addAccount(): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    try {
      setAccounts(await window.api.addAccount())
    } catch {
      setOperationFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function activateAccount(accountId: string): Promise<void> {
    if (accountId === activeAccountId) return
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    try {
      setAccounts(await window.api.activateAccount(accountId))
    } catch {
      setOperationFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function removeActiveAccount(): Promise<void> {
    if (!activeAccountId) return
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    try {
      const result = await window.api.removeAccount(activeAccountId)
      setAccounts(result.state)
      setRemovalFailed(result.outcome === 'failed')
    } catch {
      setRemovalFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function retry(): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    try {
      if (activeAccountId) {
        await window.api.retryAccount()
      } else {
        const [appInfo, state] = await Promise.all([
          window.api.getAppInfo(),
          window.api.getAccounts()
        ])
        setInfo(appInfo)
        setAccounts(state)
      }
    } catch {
      setOperationFailed(true)
      setBusy(false)
      return
    }
    setBusy(false)
  }

  let statusMessage = text.pending
  if (accounts && accounts.accounts.length === 0) statusMessage = ''
  else if (currentStatus === 'loading') statusMessage = text.loading
  else if (currentStatus === 'ready') statusMessage = text.ready
  else if (currentStatus === 'error') statusMessage = text.error
  else if (currentStatus === 'blocked') statusMessage = text.blocked
  if (removalFailed) statusMessage = text.removeError
  if (operationFailed) statusMessage = text.operationError

  return (
    <div className="app-shell">
      <header className="account-chrome">
        <div className="wordmark">{text.wordmark}</div>
        <nav
          className="account-list"
          aria-label={locale === 'ko' ? 'Gmail 계정' : 'Gmail accounts'}
        >
          {accounts?.accounts.map((account, index) => (
            <button
              className="account-button"
              key={account.id}
              type="button"
              aria-pressed={account.id === activeAccountId}
              disabled={accountActionsBusy}
              onClick={() => void activateAccount(account.id)}
            >
              Gmail {index + 1}
            </button>
          ))}
        </nav>
        <button
          className="add-account"
          type="button"
          disabled={accountActionsBusy || accounts === null}
          onClick={() => void addAccount()}
        >
          <span aria-hidden="true">＋</span> {text.add}
        </button>
        <button
          className="remove-account"
          type="button"
          disabled={accountActionsBusy || activeAccountId === null}
          onClick={() => void removeActiveAccount()}
        >
          {text.remove}
        </button>
      </header>
      <div className="status-strip">
        <span className="status-text" role="status" aria-live="polite">
          {statusMessage}
        </span>
        {(currentStatus === 'error' ||
          currentStatus === 'blocked' ||
          (operationFailed && !removalFailed)) && (
          <button
            className="retry-button"
            type="button"
            disabled={accountActionsBusy}
            onClick={() => void retry()}
          >
            {text.retry}
          </button>
        )}
        {activeAccountId && (
          <div className="api-connection" role="group" aria-label={text.apiLabel}>
            <span
              className="api-connection-status"
              role="status"
              aria-live="polite"
              aria-busy={googleStateMatches && (googleState.loading || googleOperation !== null)}
              title={googleMessage}
            >
              {googleMessage}
            </span>
            {googleStateMatches && googleState.readFailed ? (
              <button
                className="api-action"
                type="button"
                disabled={busy || googleState.loading}
                onClick={() => void googleController.current?.refresh()}
              >
                {text.retry}
              </button>
            ) : googleStatus === 'connected' ? (
              <button
                className="api-action"
                type="button"
                disabled={busy || googleOperation !== null}
                onClick={() => void googleController.current?.disconnect()}
              >
                {text.apiDisconnect}
              </button>
            ) : googleStatus === 'connecting' ? (
              <button
                className="api-action"
                type="button"
                disabled={busy || googleOperation === 'cancelling'}
                onClick={() => void googleController.current?.cancel()}
              >
                {text.apiCancel}
              </button>
            ) : googleStatus === 'disconnected' ||
              googleStatus === 'reconnect_required' ||
              googleStatus === 'error' ? (
              <button
                className="api-action"
                type="button"
                disabled={busy || googleOperation !== null}
                onClick={() => void googleController.current?.connect()}
              >
                {googleStatus === 'disconnected' ? text.apiConnect : text.apiReconnect}
              </button>
            ) : null}
          </div>
        )}
      </div>
      {accounts?.accounts.length === 0 && (
        <main className="empty-state">
          <p>{text.welcome}</p>
        </main>
      )}
      {activeIndex < 0 && !accounts && <main className="loading-state">{statusMessage}</main>}
    </div>
  )
}

export default App
