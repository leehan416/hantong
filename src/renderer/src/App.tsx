import { useEffect, useRef, useState } from 'react'
import type { AccountState } from '../../shared/accounts'
import {
  ACCOUNT_SELECTOR_POSITION_OPTIONS,
  GMAIL_CLEANUP_FIELDS,
  type AccountSelectorPosition,
  type AppSettings,
  type AppSettingsPatch
} from '../../shared/settings'
import type { AccountAccessState, AccountViewStatus, AppInfo, UnreadCounts } from '../../shared/ipc'
import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH
} from '../../shared/ipc'
import { AccountSelector } from './AccountSelector'
import {
  AccountAccessController,
  type AccountAccessUiState,
  GoogleConnectionController,
  type GoogleConnectionUiState
} from './google-connection-controller'

const messages = {
  ko: {
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
    unreadLabel: (accountNumber: number, count: number) =>
      `Gmail ${accountNumber}, 읽지 않은 메일 ${count}통`,
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
    apiFailure: '연결을 완료하지 못했습니다. 다시 시도해 주세요.',
    position: '계정 선택 영역 위치',
    positions: { top: '상단', bottom: '하단', left: '좌측', right: '우측' },
    collapse: '사이드바 접기',
    expand: '사이드바 펼치기',
    accessCheckingTitle: '메일을 준비하고 있습니다',
    accessChecking: 'Google 연결 상태를 확인하고 있습니다.',
    accessRequiredTitle: 'Google 계정을 연결해 주세요',
    accessRequired: '메일을 보려면 Google 계정 연결이 필요합니다.',
    accessErrorTitle: '메일 연결을 확인할 수 없습니다',
    accessError: 'Google 계정을 다시 연결해 주세요.',
    accessRetry: '상태 확인',
    accessCancel: '연결 취소',
    accessConnecting: '브라우저에서 Google 로그인을 완료해 주세요.',
    settings: '설정',
    settingsClose: '닫기',
    settingsGeneral: '일반',
    settingsAccounts: '계정 관리',
    accountName: '표시 이름',
    accountNamePlaceholder: '이메일 주소 사용',
    defaultAccount: '기본 계정',
    currentDefault: '기본',
    setDefault: '기본 계정으로 설정',
    noAccounts: '연결된 계정이 없습니다.',
    accountSaveError: '계정 설정을 저장하지 못했습니다. 다시 시도해 주세요.',
    accountActionError: '계정 작업을 완료하지 못했습니다. 다시 시도해 주세요.',
    settingsError: '설정을 저장하지 못했습니다. 다시 시도해 주세요.',
    language: '언어',
    languageOptions: { system: '시스템 설정', ko: '한국어', en: 'English' },
    theme: '테마',
    themeOptions: { system: '시스템 설정', light: '밝게', dark: '어둡게' },
    closeAction: '창을 닫을 때',
    closeActionOptions: { hide: '숨기기 (알림 계속 받기)', quit: '앱 종료' },
    gmailCleanup: 'Gmail 화면에서 숨기기',
    gmailCleanupOptions: {
      hideGmailLogo: 'Gmail 로고',
      hideGemini: 'Gemini 버튼',
      hideSidePanel: '오른쪽 부가기능 패널',
      hideStoragePromo: '저장용량·업그레이드 안내'
    }
  },
  en: {
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
    unreadLabel: (accountNumber: number, count: number) =>
      `Gmail ${accountNumber}, ${count} unread`,
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
    apiFailure: 'Unable to complete the connection. Please try again.',
    position: 'Account selector position',
    positions: { top: 'Top', bottom: 'Bottom', left: 'Left', right: 'Right' },
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    accessCheckingTitle: 'Preparing your mail',
    accessChecking: 'Checking the Google connection.',
    accessRequiredTitle: 'Connect a Google account',
    accessRequired: 'Connect a Google account to view mail.',
    accessErrorTitle: 'Unable to verify the mail connection',
    accessError: 'Reconnect your Google account to continue.',
    accessRetry: 'Check status',
    accessCancel: 'Cancel connection',
    accessConnecting: 'Complete Google sign-in in your browser.',
    settings: 'Settings',
    settingsClose: 'Close',
    settingsGeneral: 'General',
    settingsAccounts: 'Accounts',
    accountName: 'Display name',
    accountNamePlaceholder: 'Use email address',
    defaultAccount: 'Default account',
    currentDefault: 'Default',
    setDefault: 'Set as default',
    noAccounts: 'No connected accounts.',
    accountSaveError: 'Unable to save account settings. Please try again.',
    accountActionError: 'Unable to complete the account action. Please try again.',
    settingsError: 'Unable to save settings. Please try again.',
    language: 'Language',
    languageOptions: { system: 'System', ko: '한국어', en: 'English' },
    theme: 'Theme',
    themeOptions: { system: 'System', light: 'Light', dark: 'Dark' },
    closeAction: 'When closing the window',
    closeActionOptions: { hide: 'Hide (keep notifications)', quit: 'Quit the app' },
    gmailCleanup: 'Hide in Gmail',
    gmailCleanupOptions: {
      hideGmailLogo: 'Gmail logo',
      hideGemini: 'Gemini button',
      hideSidePanel: 'Right-side add-on panel',
      hideStoragePromo: 'Storage and upgrade prompts'
    }
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
  const [accessState, setAccessState] = useState<AccountAccessUiState>({
    accountId: null,
    state: null,
    loading: false,
    readFailed: false
  })
  const googleController = useRef<GoogleConnectionController | null>(null)
  const accessController = useRef<AccountAccessController | null>(null)
  const [busy, setBusy] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'general' | 'accounts'>('general')
  const [accountNameDrafts, setAccountNameDrafts] = useState<Record<string, string>>({})
  const [accountSettingsBusy, setAccountSettingsBusy] = useState<string | null>(null)
  const [accountSettingsFailed, setAccountSettingsFailed] = useState(false)
  const [accountNameSaveFailed, setAccountNameSaveFailed] = useState(false)
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsWasOpenRef = useRef(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [removalFailed, setRemovalFailed] = useState(false)
  const locale =
    settings && settings.language !== 'system'
      ? settings.language
      : (info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en'))
  const text = messages[locale]
  const position = settings?.accountSelectorPosition ?? 'top'
  const sidebarCollapsed = settings?.sidebarCollapsed ?? false
  const activeAccountId = accounts?.activeAccountId ?? null
  const activeIndex =
    accounts?.accounts.findIndex((account) => account.id === activeAccountId) ?? -1
  const currentStatus = viewStatus?.accountId === activeAccountId ? viewStatus.status : null
  const googleStateMatches = googleState.accountId === activeAccountId
  const googleStatus = googleStateMatches ? googleState.status : null
  const googleOperation = googleStateMatches ? googleState.operation : null
  const accessMatches = accessState.accountId === activeAccountId
  const access = accessMatches ? accessState.state : null
  const accessReady = access?.status === 'ready'
  const gateVisible = Boolean(activeAccountId && access?.status !== 'sign_in' && !accessReady)
  const accountActionsBusy =
    busy ||
    googleOperation !== null ||
    googleStatus === 'connecting' ||
    access?.connectionStatus === 'connecting'

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
    const controller = new AccountAccessController(
      window.api,
      setAccessState,
      (state: AccountAccessState) => {
        googleController.current?.applyExternalStatus({
          accountId: state.accountId,
          status: state.connectionStatus
        })
      }
    )
    accessController.current = controller
    return () => {
      controller.dispose()
      if (accessController.current === controller) accessController.current = null
    }
  }, [])

  useEffect(() => {
    googleController.current?.selectAccount(activeAccountId)
    accessController.current?.selectAccount(activeAccountId)
  }, [activeAccountId])

  useEffect(() => {
    let active = true
    let subscriptionFailed = false
    let unsubscribe = (): void => {}
    let unsubscribeAccounts = (): void => {}
    let unsubscribeUnread = (): void => {}
    try {
      unsubscribe = window.api.onAccountViewStatus((status) => {
        if (active) setViewStatus(status)
      })
      // Main switches accounts on its own when a mail notification is clicked.
      unsubscribeAccounts = window.api.onAccountState((state) => {
        if (active) setAccounts(state)
      })
      unsubscribeUnread = window.api.onUnreadCounts((counts) => {
        if (active) setUnreadCounts(counts)
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
      unsubscribeAccounts()
      unsubscribeUnread()
    }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe = (): void => {}
    let unsubscribeOpen = (): void => {}
    try {
      unsubscribe = window.api.onSettings((next) => {
        if (active) setSettings(next)
      })
      unsubscribeOpen = window.api.onOpenSettings(() => {
        if (active) openSettings()
      })
    } catch {
      // Without the push channel the panel still shows the values it saved itself.
    }
    void window.api.getSettings().then(
      (next) => {
        if (active) setSettings(next)
      },
      () => undefined
    )
    return () => {
      active = false
      unsubscribe()
      unsubscribeOpen()
    }
  }, [])

  useEffect(() => {
    // Main detaches the native Gmail view while the modal is open, or it would cover the dialog.
    const dialog = settingsDialogRef.current
    if (settingsOpen) {
      if (dialog && !dialog.open) dialog.showModal()
      void window.api.setSettingsPanelOpen(true).catch(() => undefined)
    } else {
      if (dialog?.open) dialog.close()
      void window.api.setSettingsPanelOpen(false).catch(() => undefined)
      if (settingsWasOpenRef.current) {
        const focusTarget = settingsReturnFocusRef.current ?? settingsButtonRef.current
        focusTarget?.focus()
        settingsReturnFocusRef.current = null
      }
    }
    settingsWasOpenRef.current = settingsOpen
  }, [settingsOpen])

  function openSettings(): void {
    const activeElement = document.activeElement
    settingsReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : settingsButtonRef.current
    setSettingsOpen(true)
  }

  async function changeSettings(patch: AppSettingsPatch): Promise<void> {
    setSettingsFailed(false)
    try {
      setSettings(await window.api.updateSettings(patch))
    } catch {
      setSettingsFailed(true)
    }
  }

  useEffect(() => {
    let active = true
    // Badges are advisory; a failed read just leaves them hidden until the next push.
    void window.api.getUnreadCounts().then(
      (counts) => {
        if (active) setUnreadCounts(counts)
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  useEffect(() => {
    document.documentElement.dataset.accountPosition = position
    document.documentElement.dataset.sidebarCollapsed = String(sidebarCollapsed)
    document.documentElement.style.setProperty(
      '--account-sidebar-width',
      `${sidebarCollapsed ? ACCOUNT_SIDEBAR_COLLAPSED_WIDTH : ACCOUNT_SIDEBAR_WIDTH}px`
    )
    document.documentElement.style.setProperty(
      '--account-chrome-height',
      `${ACCOUNT_CHROME_HEIGHT}px`
    )
  }, [position, sidebarCollapsed])

  async function addAccount(): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    setAccountSettingsFailed(false)
    try {
      setAccounts(await window.api.addAccount())
    } catch {
      setOperationFailed(true)
      setAccountSettingsFailed(true)
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

  async function removeAccount(accountId: string): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    setAccountSettingsFailed(false)
    try {
      const result = await window.api.removeAccount(accountId)
      setAccounts(result.state)
      setRemovalFailed(result.outcome === 'failed')
      setAccountSettingsFailed(result.outcome === 'failed')
    } catch {
      setRemovalFailed(true)
      setAccountSettingsFailed(true)
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

  async function reconnectFromGate(): Promise<void> {
    await googleController.current?.connect(true)
    await accessController.current?.refresh()
  }

  async function cancelFromGate(): Promise<void> {
    await googleController.current?.cancel()
    await accessController.current?.refresh()
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
      <div className={`account-layout account-layout-${position}`}>
        <header className="account-chrome">
          {position === 'left' || position === 'right' ? (
            <>
              <div className="sidebar-main">
                <AccountSelector
                  accounts={accounts?.accounts ?? []}
                  activeAccountId={activeAccountId}
                  unreadCounts={unreadCounts}
                  locale={locale}
                  disabled={accountActionsBusy}
                  addDisabled={accountActionsBusy || accounts === null}
                  onActivate={(id) => void activateAccount(id)}
                  onAdd={() => void addAccount()}
                />
                {!sidebarCollapsed && (
                  <>
                    <button
                      className="sidebar-add"
                      type="button"
                      disabled={accountActionsBusy || accounts === null}
                      onClick={() => void addAccount()}
                    >
                      <span aria-hidden="true">＋</span> {text.add}
                    </button>
                  </>
                )}
              </div>
              <div className="sidebar-footer">
                <button
                  className="sidebar-toggle"
                  type="button"
                  aria-label={sidebarCollapsed ? text.expand : text.collapse}
                  title={sidebarCollapsed ? text.expand : text.collapse}
                  onClick={() => void changeSettings({ sidebarCollapsed: !sidebarCollapsed })}
                >
                  <span aria-hidden="true">{sidebarCollapsed ? '›' : '‹'}</span>
                  {!sidebarCollapsed && <span>{text.collapse}</span>}
                </button>
                <button
                  className="settings-button"
                  type="button"
                  ref={settingsButtonRef}
                  aria-pressed={settingsOpen}
                  onClick={openSettings}
                >
                  {text.settings}
                </button>
              </div>
            </>
          ) : (
            <>
              <AccountSelector
                accounts={accounts?.accounts ?? []}
                activeAccountId={activeAccountId}
                unreadCounts={unreadCounts}
                locale={locale}
                disabled={accountActionsBusy}
                addDisabled={accountActionsBusy || accounts === null}
                onActivate={(id) => void activateAccount(id)}
                onAdd={() => void addAccount()}
              />
              <button
                className="add-account"
                type="button"
                disabled={accountActionsBusy || accounts === null}
                aria-label={text.add}
                title={text.add}
                onClick={() => void addAccount()}
              >
                <span aria-hidden="true">＋</span>
              </button>
              <button
                className="settings-button"
                type="button"
                ref={settingsButtonRef}
                aria-pressed={settingsOpen}
                onClick={openSettings}
              >
                {text.settings}
              </button>
            </>
          )}
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
              {accessReady && googleStateMatches && googleState.readFailed ? (
                <button
                  className="api-action"
                  type="button"
                  disabled={busy || googleState.loading}
                  onClick={() => void googleController.current?.refresh()}
                >
                  {text.retry}
                </button>
              ) : accessReady && googleStatus === 'connected' ? (
                <button
                  className="api-action"
                  type="button"
                  disabled={busy || googleOperation !== null}
                  onClick={() => void googleController.current?.disconnect()}
                >
                  {text.apiDisconnect}
                </button>
              ) : accessReady && googleStatus === 'connecting' ? (
                <button
                  className="api-action"
                  type="button"
                  disabled={busy || googleOperation === 'cancelling'}
                  onClick={() => void googleController.current?.cancel()}
                >
                  {text.apiCancel}
                </button>
              ) : accessReady &&
                (googleStatus === 'disconnected' ||
                  googleStatus === 'reconnect_required' ||
                  googleStatus === 'error') ? (
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
      </div>
      <dialog
        ref={settingsDialogRef}
        className="settings-panel"
        aria-labelledby="settings-title"
        onCancel={(event) => event.preventDefault()}
      >
        <section className="settings-content">
          <header className="settings-heading">
            <h1 id="settings-title">{text.settings}</h1>
            <button
              className="settings-close"
              type="button"
              aria-label={text.settingsClose}
              title={text.settingsClose}
              onClick={() => setSettingsOpen(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          <nav className="settings-navigation" aria-label={text.settings} role="tablist">
            {(['general', 'accounts'] as const).map((section) => (
              <button
                key={section}
                className="settings-navigation-item"
                type="button"
                role="tab"
                id={`settings-tab-${section}`}
                aria-selected={settingsSection === section}
                aria-controls={`settings-panel-${section}`}
                onClick={() => setSettingsSection(section)}
              >
                {section === 'general' ? text.settingsGeneral : text.settingsAccounts}
              </button>
            ))}
          </nav>
          {settingsSection === 'general' ? (
            <div
              id="settings-panel-general"
              role="tabpanel"
              aria-labelledby="settings-tab-general"
              className="settings-tab-panel"
            >
              <details className="settings-position">
                <summary className="settings-position-trigger">
                  <span>{text.position}</span>
                  <span className="settings-position-current">
                    {text.positions[position]} <span aria-hidden="true">⌄</span>
                  </span>
                </summary>
                <fieldset className="settings-position-options">
                  <legend className="visually-hidden">{text.position}</legend>
                  {ACCOUNT_SELECTOR_POSITION_OPTIONS.map((option) => (
                    <label key={option} className="settings-position-option">
                      <input
                        type="radio"
                        name="account-selector-position"
                        value={option}
                        checked={position === option}
                        onChange={() =>
                          void changeSettings({
                            accountSelectorPosition: option as AccountSelectorPosition
                          })
                        }
                      />
                      {text.positions[option]}
                    </label>
                  ))}
                </fieldset>
              </details>
              {(
                [
                  ['language', text.language, text.languageOptions],
                  ['theme', text.theme, text.themeOptions],
                  ['closeAction', text.closeAction, text.closeActionOptions]
                ] as const
              ).map(([field, label, options]) => (
                <fieldset key={field} className="settings-group">
                  <legend>{label}</legend>
                  {Object.entries(options).map(([value, optionLabel]) => (
                    <label key={value} className="settings-option">
                      <input
                        type="radio"
                        name={field}
                        value={value}
                        checked={settings?.[field] === value}
                        onChange={() => void changeSettings({ [field]: value })}
                      />
                      {optionLabel}
                    </label>
                  ))}
                </fieldset>
              ))}
              <fieldset className="settings-group">
                <legend>{text.gmailCleanup}</legend>
                {GMAIL_CLEANUP_FIELDS.map((field) => (
                  <label key={field} className="settings-option">
                    <input
                      type="checkbox"
                      checked={settings?.[field] === true}
                      onChange={(event) => void changeSettings({ [field]: event.target.checked })}
                    />
                    {text.gmailCleanupOptions[field]}
                  </label>
                ))}
              </fieldset>
              {settingsFailed && <p role="alert">{text.settingsError}</p>}
            </div>
          ) : (
            <div
              id="settings-panel-accounts"
              role="tabpanel"
              aria-labelledby="settings-tab-accounts"
              className="settings-tab-panel"
            >
              <div className="settings-section-heading">
                <h2>{text.settingsAccounts}</h2>
                <button
                  className="settings-add-account"
                  type="button"
                  disabled={accountActionsBusy || accounts === null}
                  onClick={() => void addAccount()}
                >
                  <span aria-hidden="true">＋</span> {text.add}
                </button>
              </div>
              {accountSettingsFailed && <p role="alert">{text.accountActionError}</p>}
              {accountNameSaveFailed && <p role="alert">{text.accountSaveError}</p>}
              {accounts?.accounts.length ? (
                <ul className="managed-account-list">
                  {accounts.accounts.map((account, index) => {
                    const accountName =
                      account.displayName?.trim() || account.email || `Gmail ${index + 1}`
                    const isDefault = accounts.defaultAccountId === account.id
                    return (
                      <li className="managed-account" key={account.id}>
                        <div className="managed-account-heading">
                          <div className="managed-account-identity">
                            <strong>{accountName}</strong>
                            <span>{account.email || '—'}</span>
                          </div>
                          {isDefault && (
                            <span className="managed-account-default">{text.currentDefault}</span>
                          )}
                        </div>
                        <label className="managed-account-name">
                          <span>{text.accountName}</span>
                          <input
                            type="text"
                            value={accountNameDrafts[account.id] ?? account.displayName ?? ''}
                            placeholder={text.accountNamePlaceholder}
                            maxLength={80}
                            disabled={accountSettingsBusy !== null || accountActionsBusy}
                            onChange={(event) =>
                              setAccountNameDrafts((drafts) => ({
                                ...drafts,
                                [account.id]: event.target.value
                              }))
                            }
                            onBlur={() => {
                              const value = accountNameDrafts[account.id]
                              if (value === undefined || value === (account.displayName ?? ''))
                                return
                              const displayName = value.trim() || null
                              setAccountSettingsBusy(account.id)
                              setAccountNameSaveFailed(false)
                              void window.api
                                .setAccountDisplayName(account.id, displayName)
                                .then(
                                  (state) => {
                                    setAccounts(state)
                                    setAccountNameDrafts((drafts) => {
                                      const next = { ...drafts }
                                      delete next[account.id]
                                      return next
                                    })
                                  },
                                  () => setAccountNameSaveFailed(true)
                                )
                                .finally(() => setAccountSettingsBusy(null))
                            }}
                            aria-label={`${text.accountName}: ${account.email ?? accountName}`}
                          />
                        </label>
                        <div className="managed-account-actions">
                          {!isDefault && (
                            <button
                              type="button"
                              disabled={accountActionsBusy || accountSettingsBusy !== null}
                              onClick={() => {
                                setAccountSettingsBusy(account.id)
                                setAccountSettingsFailed(false)
                                void window.api
                                  .setDefaultAccount(account.id)
                                  .then(setAccounts, () => setAccountSettingsFailed(true))
                                  .finally(() => setAccountSettingsBusy(null))
                              }}
                            >
                              {text.setDefault}
                            </button>
                          )}
                          <button
                            className="managed-account-remove"
                            type="button"
                            disabled={accountActionsBusy || accountSettingsBusy !== null}
                            onClick={() => void removeAccount(account.id)}
                          >
                            {text.remove}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="settings-empty-accounts">
                  {accounts ? text.noAccounts : text.pending}
                </p>
              )}
            </div>
          )}
        </section>
      </dialog>
      {!settingsOpen && accounts?.accounts.length === 0 && (
        <main className="empty-state">
          <p>{text.welcome}</p>
        </main>
      )}
      {!settingsOpen && gateVisible && activeAccountId && (
        <main className="access-gate" aria-labelledby="access-gate-title">
          <section
            className="access-gate-content"
            aria-live="polite"
            aria-busy={accessState.loading}
          >
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
                onClick={() => void accessController.current?.refresh()}
              >
                {text.accessRetry}
              </button>
            ) : access?.connectionStatus === 'connecting' ? (
              <button
                className="access-gate-action"
                type="button"
                disabled={googleOperation === 'cancelling'}
                onClick={() => void cancelFromGate()}
              >
                {googleOperation === 'cancelling' ? text.apiCancelling : text.accessCancel}
              </button>
            ) : access?.status === 'required' || access?.status === 'error' ? (
              <button
                className="access-gate-action"
                type="button"
                disabled={busy || googleOperation !== null}
                onClick={() => void reconnectFromGate()}
              >
                {googleOperation === 'connecting' ? text.apiConnecting : text.apiReconnect}
              </button>
            ) : null}
          </section>
        </main>
      )}
      {activeIndex < 0 && !accounts && <main className="loading-state">{statusMessage}</main>}
    </div>
  )
}

export default App
