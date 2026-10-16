import { useEffect, useState } from 'react'
import type { AccountState } from '../../shared/accounts'
import type { AccountViewStatus, AppInfo } from '../../shared/ipc'

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
    removeError: '계정을 삭제하지 못했습니다. 다시 시도해 주세요.'
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
    removeError: 'Unable to remove the account. Please try again.'
  }
}

function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [accounts, setAccounts] = useState<AccountState | null>(null)
  const [viewStatus, setViewStatus] = useState<AccountViewStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [removalFailed, setRemovalFailed] = useState(false)
  const locale = info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en')
  const text = messages[locale]
  const activeAccountId = accounts?.activeAccountId ?? null
  const activeIndex =
    accounts?.accounts.findIndex((account) => account.id === activeAccountId) ?? -1
  const currentStatus = viewStatus?.accountId === activeAccountId ? viewStatus.status : null

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
              disabled={busy}
              onClick={() => void activateAccount(account.id)}
            >
              Gmail {index + 1}
            </button>
          ))}
        </nav>
        <button
          className="add-account"
          type="button"
          disabled={busy || accounts === null}
          onClick={() => void addAccount()}
        >
          <span aria-hidden="true">＋</span> {text.add}
        </button>
        <button
          className="remove-account"
          type="button"
          disabled={busy || activeAccountId === null}
          onClick={() => void removeActiveAccount()}
        >
          {text.remove}
        </button>
      </header>
      <div className="status-strip" role="status" aria-live="polite">
        <span className="status-text">{statusMessage}</span>
        {(currentStatus === 'error' ||
          currentStatus === 'blocked' ||
          (operationFailed && !removalFailed)) && (
          <button
            className="retry-button"
            type="button"
            disabled={busy}
            onClick={() => void retry()}
          >
            {text.retry}
          </button>
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
