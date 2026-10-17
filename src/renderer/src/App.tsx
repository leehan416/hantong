import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AccountState } from '../../shared/accounts'
import { ACCOUNT_COLOR_OPTIONS, accountLabel, MAX_ACCOUNTS } from '../../shared/accounts'
import { getAccountViewBounds } from '../../shared/account-layout'
import {
  ACCOUNT_SELECTOR_POSITION_OPTIONS,
  GMAIL_CLEANUP_FIELDS,
  type AccountSelectorPosition,
  type AppSettings,
  type AppSettingsPatch
} from '../../shared/settings'
import type {
  AccountAccessState,
  AccountViewSnapshot,
  AccountViewStatus,
  AppInfo,
  UnreadCounts
} from '../../shared/ipc'
import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH
} from '../../shared/ipc'
import { AccountCardNavigation, SidebarAccountNavigation } from './AccountSelector'
import { IconActionButton } from './IconActionButton'
import {
  AccountAccessController,
  type AccountAccessUiState,
  GoogleConnectionControllerPool,
  hasPendingGoogleConnection,
  type GoogleConnectionUiState
} from './google-connection-controller'

const messages = {
  ko: {
    add: '계정 추가',
    remove: '계정 삭제',
    removeAction: '삭제',
    accountLimit: '계정은 최대 10개까지 추가할 수 있습니다.',
    welcome: 'Gmail 계정을 추가해 시작하세요.',
    pending: '계정을 불러오는 중…',
    error: 'Gmail을 불러오지 못했습니다.',
    blocked: '허용되지 않은 페이지 이동을 차단했습니다.',
    retry: '다시 시도',
    operationError: '요청을 완료하지 못했습니다. 다시 시도해 주세요.',
    removeError: '계정을 삭제하지 못했습니다. 다시 시도해 주세요.',
    apiCheckError: 'API 연결 상태를 확인하지 못했습니다.',
    apiConnecting: '브라우저에서 인증을 완료해 주세요.',
    apiCancelling: '연결 취소 중…',
    apiReconnect: '다시 연결',
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
    settingsAppearance: '외관',
    accountName: '표시 이름',
    editName: '수정',
    accountNamePlaceholder: '이메일 주소 사용',
    accountColor: '계정 색상',
    accountColors: { blue: '파랑', purple: '보라', green: '초록', orange: '주황', gray: '회색' },
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
      hideHeaderButtons: '상단 부가 버튼 (지원·설정·Gemini·Google 앱)',
      hideSidePanel: '오른쪽 부가기능 패널',
      hideStoragePromo: '저장용량·업그레이드 안내'
    }
  },
  en: {
    add: 'Add account',
    remove: 'Remove account',
    removeAction: 'Remove',
    accountLimit: 'You can add up to 10 accounts.',
    welcome: 'Add a Gmail account to get started.',
    pending: 'Loading accounts…',
    error: 'Unable to load Gmail.',
    blocked: 'A page navigation was blocked.',
    retry: 'Retry',
    operationError: 'Unable to complete the request. Please try again.',
    removeError: 'Unable to remove the account. Please try again.',
    apiCheckError: 'Unable to check API connection status.',
    apiConnecting: 'Complete sign-in in your browser.',
    apiCancelling: 'Cancelling connection…',
    apiReconnect: 'Reconnect',
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
    settingsAppearance: 'Appearance',
    accountName: 'Display name',
    editName: 'Edit',
    accountNamePlaceholder: 'Use email address',
    accountColor: 'Account color',
    accountColors: {
      blue: 'Blue',
      purple: 'Purple',
      green: 'Green',
      orange: 'Orange',
      gray: 'Gray'
    },
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
      hideHeaderButtons: 'Top bar extras (Support, Settings, Gemini, Google apps)',
      hideSidePanel: 'Right-side add-on panel',
      hideStoragePromo: 'Storage and upgrade prompts'
    }
  }
}

function SettingsRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="settings-row">
      <span className="settings-row-label">{label}</span>
      {children}
    </label>
  )
}

function App(): React.JSX.Element {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [accounts, setAccounts] = useState<AccountState | null>(null)
  const [viewStatus, setViewStatus] = useState<AccountViewStatus | null>(null)
  const [googleStates, setGoogleStates] = useState<Record<string, GoogleConnectionUiState>>({})
  const [accessState, setAccessState] = useState<AccountAccessUiState>({
    accountId: null,
    state: null,
    loading: false,
    readFailed: false
  })
  const googleControllerPool = useRef<GoogleConnectionControllerPool | null>(null)
  const accessController = useRef<AccountAccessController | null>(null)
  const [busy, setBusy] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>({})
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBackground, setSettingsBackground] = useState<AccountViewSnapshot | null>(null)
  const [settingsPanelFailed, setSettingsPanelFailed] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'general' | 'accounts' | 'appearance'>(
    'general'
  )
  const [accountNameDrafts, setAccountNameDrafts] = useState<Record<string, string>>({})
  const [accountSettingsBusy, setAccountSettingsBusy] = useState<string | null>(null)
  const [accountSettingsFailed, setAccountSettingsFailed] = useState(false)
  const [accountNameSaveFailed, setAccountNameSaveFailed] = useState(false)
  const [accountLimitReached, setAccountLimitReached] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const nameEditCancelledRef = useRef(false)
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsWasOpenRef = useRef(false)
  const settingsOpeningRef = useRef(false)
  const [operationFailed, setOperationFailed] = useState(false)
  const [removalFailed, setRemovalFailed] = useState(false)
  const [statusStripLayoutVisible, setStatusStripLayoutVisible] = useState(true)
  const statusStripLayoutRevision = useRef(0)
  const locale =
    settings && settings.language !== 'system'
      ? settings.language
      : (info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en'))
  const text = messages[locale]
  const sectionTitles = {
    general: text.settingsGeneral,
    accounts: text.settingsAccounts,
    appearance: text.settingsAppearance
  }
  const position = settings?.accountSelectorPosition ?? 'top'
  const sidebarCollapsed = settings?.sidebarCollapsed ?? false
  const activeAccountId = accounts?.activeAccountId ?? null
  const activeIndex =
    accounts?.accounts.findIndex((account) => account.id === activeAccountId) ?? -1
  const currentStatus = viewStatus?.accountId === activeAccountId ? viewStatus.status : null
  const googleState = activeAccountId ? googleStates[activeAccountId] : undefined
  const googleOperation = googleState?.operation ?? null
  const accessMatches = accessState.accountId === activeAccountId
  const access = accessMatches ? accessState.state : null
  const accessReady = access?.status === 'ready'
  const gateVisible = Boolean(activeAccountId && access?.status !== 'sign_in' && !accessReady)
  const accountActionsBusy =
    busy ||
    hasPendingGoogleConnection(Object.values(googleStates)) ||
    access?.connectionStatus === 'connecting'

  useEffect(() => {
    const controller = new GoogleConnectionControllerPool(window.api, (state) => {
      const { accountId } = state
      if (accountId) setGoogleStates((states) => ({ ...states, [accountId]: state }))
    })
    googleControllerPool.current = controller
    return () => {
      controller.dispose()
      if (googleControllerPool.current === controller) googleControllerPool.current = null
    }
  }, [])

  useEffect(() => {
    const controller = new AccountAccessController(
      window.api,
      setAccessState,
      (state: AccountAccessState) => {
        googleControllerPool.current?.applyExternalStatus({
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
    if (activeAccountId) googleControllerPool.current?.forAccount(activeAccountId)
    accessController.current?.selectAccount(activeAccountId)
  }, [activeAccountId])

  const openSettings = useCallback(async (): Promise<void> => {
    if (settingsDialogRef.current?.open || settingsOpeningRef.current) return
    settingsOpeningRef.current = true
    const activeElement = document.activeElement
    settingsReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : settingsButtonRef.current
    let panelSetupFailed = false
    try {
      setSettingsPanelFailed(false)
      let snapshot = await window.api.setSettingsPanelOpen(true)
      if (snapshot) {
        const image = new Image()
        image.src = snapshot.dataUrl
        try {
          await image.decode()
        } catch {
          snapshot = null
        }
      }
      setSettingsBackground(snapshot)
    } catch {
      setSettingsBackground(null)
      try {
        await window.api.setSettingsPanelOpen(false)
      } catch {
        panelSetupFailed = true
      }
    } finally {
      settingsOpeningRef.current = false
      if (panelSetupFailed) setSettingsPanelFailed(true)
      setSettingsOpen(true)
    }
  }, [])

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
        if (active) void openSettings()
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
  }, [openSettings])

  useEffect(() => {
    const dialog = settingsDialogRef.current
    if (settingsOpen) {
      if (dialog && !dialog.open) dialog.showModal()
    } else {
      if (dialog?.open) dialog.close()
      if (settingsWasOpenRef.current) {
        const focusTarget = settingsReturnFocusRef.current ?? settingsButtonRef.current
        focusTarget?.focus()
        settingsReturnFocusRef.current = null
      }
    }
    settingsWasOpenRef.current = settingsOpen
  }, [settingsOpen])

  async function closeSettings(): Promise<void> {
    let panelCloseFailed = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await window.api.setSettingsPanelOpen(false)
        panelCloseFailed = false
        break
      } catch {
        panelCloseFailed = true
      }
    }
    if (panelCloseFailed) {
      setSettingsPanelFailed(true)
      return
    }
    setSettingsPanelFailed(false)
    try {
      setSettingsBackground(null)
      setSettingsOpen(false)
    } catch {
      setSettingsFailed(true)
    }
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
    document.documentElement.dataset.theme = settings?.theme ?? 'system'
  }, [settings?.theme])

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
    setAccountLimitReached(false)
    if ((accounts?.accounts.length ?? 0) >= MAX_ACCOUNTS) {
      setAccountLimitReached(true)
      return
    }
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

  async function moveAccount(accountId: string, toIndex: number): Promise<void> {
    setOperationFailed(false)
    try {
      setAccounts(await window.api.moveAccount(accountId, toIndex))
    } catch {
      setOperationFailed(true)
    }
  }

  async function removeAccount(accountId: string): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    setAccountSettingsFailed(false)
    try {
      const result = await window.api.removeAccount(accountId)
      googleControllerPool.current?.remove(accountId)
      setGoogleStates((states) => {
        const next = { ...states }
        delete next[accountId]
        return next
      })
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
    if (!activeAccountId) return
    await googleControllerPool.current?.forAccount(activeAccountId).connect(true)
    await accessController.current?.refresh()
  }

  async function cancelFromGate(): Promise<void> {
    if (!activeAccountId) return
    await googleControllerPool.current?.forAccount(activeAccountId).cancel()
    await accessController.current?.refresh()
  }

  // The strip only appears for something the user can act on; loading progress stays silent.
  let statusMessage = ''
  if (currentStatus === 'error') statusMessage = text.error
  else if (currentStatus === 'blocked') statusMessage = text.blocked
  if (removalFailed) statusMessage = text.removeError
  if (operationFailed) statusMessage = text.operationError
  const showStatusStrip = Boolean(statusMessage)

  // The snapshot stands in for the detached Gmail view, so it follows layout changes made in
  // settings instead of staying where the view was captured.
  // Once another account is active (removal, notification click) the snapshot would show the
  // wrong mailbox, so it is only drawn for the account it was captured from.
  const snapshotBounds =
    settingsBackground?.accountId === activeAccountId
      ? getAccountViewBounds({
          width: window.innerWidth,
          height: window.innerHeight,
          position,
          sidebarCollapsed,
          statusStripVisible: statusStripLayoutVisible
        })
      : null

  useEffect(() => {
    if (showStatusStrip === statusStripLayoutVisible) return
    const revision = ++statusStripLayoutRevision.current
    void window.api.setStatusStripVisible(showStatusStrip).then(
      () => {
        if (statusStripLayoutRevision.current === revision) {
          setStatusStripLayoutVisible(showStatusStrip)
        }
      },
      // Main could not move the Gmail view; still show the strip so its error text is reachable.
      () => {
        if (statusStripLayoutRevision.current === revision) {
          setStatusStripLayoutVisible(showStatusStrip)
        }
      }
    )
  }, [showStatusStrip, statusStripLayoutVisible])

  useLayoutEffect(() => {
    document.documentElement.dataset.statusStripVisible = String(statusStripLayoutVisible)
  }, [statusStripLayoutVisible])

  return (
    <div className="app-shell">
      <div className={`account-layout account-layout-${position}`}>
        <header className="account-chrome">
          {position === 'left' || position === 'right' ? (
            <>
              <div className="sidebar-main">
                <SidebarAccountNavigation
                  accounts={accounts?.accounts ?? []}
                  activeAccountId={activeAccountId}
                  unreadCounts={unreadCounts}
                  locale={locale}
                  collapsed={sidebarCollapsed}
                  disabled={accountActionsBusy}
                  addDisabled={accountActionsBusy || accounts === null}
                  onActivate={(id) => void activateAccount(id)}
                  onAdd={() => void addAccount()}
                  onMove={(id, index) => void moveAccount(id, index)}
                />
              </div>
              <div className="sidebar-footer">
                <IconActionButton
                  action={sidebarCollapsed ? 'sidebar-expand' : 'sidebar-collapse'}
                  className="sidebar-action"
                  data-position={position}
                  type="button"
                  aria-label={sidebarCollapsed ? text.expand : text.collapse}
                  title={sidebarCollapsed ? text.expand : text.collapse}
                  onClick={() => void changeSettings({ sidebarCollapsed: !sidebarCollapsed })}
                />
                <IconActionButton
                  action="settings"
                  className="settings-trigger"
                  type="button"
                  ref={settingsButtonRef}
                  aria-label={text.settings}
                  title={text.settings}
                  aria-pressed={settingsOpen}
                  onClick={() => void openSettings()}
                />
              </div>
            </>
          ) : (
            <>
              <AccountCardNavigation
                accounts={accounts?.accounts ?? []}
                activeAccountId={activeAccountId}
                unreadCounts={unreadCounts}
                locale={locale}
                disabled={accountActionsBusy}
                addDisabled={accountActionsBusy || accounts === null}
                onActivate={(id) => void activateAccount(id)}
                onAdd={() => void addAccount()}
                onMove={(id, index) => void moveAccount(id, index)}
              />
              <IconActionButton
                action="settings"
                className="settings-trigger"
                type="button"
                ref={settingsButtonRef}
                aria-label={text.settings}
                title={text.settings}
                aria-pressed={settingsOpen}
                onClick={() => void openSettings()}
              />
            </>
          )}
        </header>
        {showStatusStrip && statusStripLayoutVisible && (
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
          </div>
        )}
      </div>
      {settingsBackground && snapshotBounds && (
        <img
          className="settings-background-snapshot"
          src={settingsBackground.dataUrl}
          alt=""
          aria-hidden="true"
          draggable={false}
          style={{
            left: snapshotBounds.x,
            top: snapshotBounds.y,
            width: snapshotBounds.width,
            height: snapshotBounds.height
          }}
        />
      )}
      <dialog
        ref={settingsDialogRef}
        className="settings-panel"
        aria-labelledby="settings-title"
        onCancel={(event) => event.preventDefault()}
      >
        <nav className="settings-navigation" aria-labelledby="settings-title" role="tablist">
          <h1 id="settings-title">{text.settings}</h1>
          {(['general', 'accounts', 'appearance'] as const).map((section) => (
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
              {sectionTitles[section]}
            </button>
          ))}
        </nav>
        <section className="settings-content">
          <header className="settings-heading">
            <h2>{sectionTitles[settingsSection]}</h2>
            <button
              className="settings-close"
              type="button"
              aria-label={text.settingsClose}
              title={text.settingsClose}
              onClick={() => void closeSettings()}
            >
              <span aria-hidden="true">×</span>
            </button>
          </header>
          {settingsPanelFailed && (
            <p className="settings-error" role="alert">
              {text.settingsError}
            </p>
          )}
          {settingsSection === 'general' ? (
            <div
              id="settings-panel-general"
              role="tabpanel"
              aria-labelledby="settings-tab-general"
              className="settings-tab-panel"
            >
              {(
                [
                  ['language', text.language, text.languageOptions],
                  ['closeAction', text.closeAction, text.closeActionOptions]
                ] as const
              ).map(([field, label, options]) => (
                <SettingsRow key={field} label={label}>
                  <select
                    className="settings-select"
                    value={settings?.[field] ?? ''}
                    disabled={!settings}
                    onChange={(event) => void changeSettings({ [field]: event.target.value })}
                  >
                    {Object.entries(options).map(([value, optionLabel]) => (
                      <option key={value} value={value}>
                        {optionLabel}
                      </option>
                    ))}
                  </select>
                </SettingsRow>
              ))}
              {settingsFailed && (
                <p className="settings-error" role="alert">
                  {text.settingsError}
                </p>
              )}
            </div>
          ) : settingsSection === 'accounts' ? (
            <div
              id="settings-panel-accounts"
              role="tabpanel"
              aria-labelledby="settings-tab-accounts"
              className="settings-tab-panel"
            >
              {accountSettingsFailed && (
                <p className="settings-error" role="alert">
                  {text.accountActionError}
                </p>
              )}
              {accountNameSaveFailed && (
                <p className="settings-error" role="alert">
                  {text.accountSaveError}
                </p>
              )}
              {accounts?.accounts.length ? (
                accounts.accounts.map((account, index) => {
                  const accountName = accountLabel(account, index)
                  const settingsLocked = accountSettingsBusy !== null || accountActionsBusy
                  return (
                    <section key={account.id} aria-label={accountName}>
                      <h3 className="settings-group-title">
                        {editingAccountId === account.id ? (
                          <input
                            className="settings-input settings-name-input"
                            type="text"
                            autoFocus
                            value={accountNameDrafts[account.id] ?? account.displayName ?? ''}
                            placeholder={account.email ?? text.accountNamePlaceholder}
                            maxLength={80}
                            aria-label={`${text.accountName}: ${account.email ?? accountName}`}
                            onChange={(event) =>
                              setAccountNameDrafts((drafts) => ({
                                ...drafts,
                                [account.id]: event.target.value
                              }))
                            }
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                // Escape would otherwise also reach the dialog; the blur below
                                // must discard the draft instead of saving it.
                                event.preventDefault()
                                nameEditCancelledRef.current = true
                              }
                              if (event.key === 'Enter' || event.key === 'Escape') {
                                event.currentTarget.blur()
                              }
                            }}
                            onBlur={() => {
                              const value = accountNameDrafts[account.id]
                              const cancelled = nameEditCancelledRef.current
                              nameEditCancelledRef.current = false
                              setEditingAccountId(null)
                              setAccountNameDrafts((drafts) => {
                                const next = { ...drafts }
                                delete next[account.id]
                                return next
                              })
                              if (
                                cancelled ||
                                value === undefined ||
                                value === (account.displayName ?? '')
                              )
                                return
                              setAccountSettingsBusy(account.id)
                              setAccountNameSaveFailed(false)
                              void window.api
                                .setAccountDisplayName(account.id, value.trim() || null)
                                .then(setAccounts, () => setAccountNameSaveFailed(true))
                                .finally(() => setAccountSettingsBusy(null))
                            }}
                          />
                        ) : (
                          <>
                            {accountName}
                            {account.email && account.email !== accountName && (
                              <small>{account.email}</small>
                            )}
                            <span className="settings-group-actions">
                              <button
                                className="settings-text-button"
                                type="button"
                                aria-label={`${text.editName}: ${accountName}`}
                                disabled={settingsLocked}
                                onClick={() => setEditingAccountId(account.id)}
                              >
                                {text.editName}
                              </button>
                              <button
                                className="settings-text-button settings-button-danger"
                                type="button"
                                aria-label={`${text.remove}: ${accountName}`}
                                disabled={settingsLocked}
                                onClick={() => void removeAccount(account.id)}
                              >
                                {text.removeAction}
                              </button>
                            </span>
                          </>
                        )}
                      </h3>
                      <div className="settings-row" role="group" aria-label={text.accountColor}>
                        <span className="settings-row-label">{text.accountColor}</span>
                        <div className="color-swatches">
                          {ACCOUNT_COLOR_OPTIONS.map((color) => (
                            <button
                              key={color}
                              className="color-swatch"
                              type="button"
                              data-account-color={color}
                              aria-label={text.accountColors[color]}
                              aria-pressed={(account.color ?? 'blue') === color}
                              title={text.accountColors[color]}
                              disabled={settingsLocked}
                              onClick={() => {
                                if ((account.color ?? 'blue') === color) return
                                setAccountSettingsBusy(account.id)
                                setAccountSettingsFailed(false)
                                void window.api
                                  .updateAccountColor(account.id, color)
                                  .then(setAccounts, () => setAccountSettingsFailed(true))
                                  .finally(() => setAccountSettingsBusy(null))
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </section>
                  )
                })
              ) : (
                <p className="settings-empty-accounts">
                  {accounts ? text.noAccounts : text.pending}
                </p>
              )}
              <button
                className="settings-add-account"
                type="button"
                disabled={accountActionsBusy || accounts === null}
                onClick={() => void addAccount()}
              >
                <span aria-hidden="true">+</span>
                {text.add}
              </button>
              {accountLimitReached && (
                <p className="settings-error" role="alert">
                  {text.accountLimit}
                </p>
              )}
            </div>
          ) : (
            <div
              id="settings-panel-appearance"
              role="tabpanel"
              aria-labelledby="settings-tab-appearance"
              className="settings-tab-panel"
            >
              <SettingsRow label={text.theme}>
                <select
                  className="settings-select"
                  value={settings?.theme ?? 'system'}
                  disabled={!settings}
                  onChange={(event) =>
                    void changeSettings({ theme: event.target.value as AppSettings['theme'] })
                  }
                >
                  {Object.entries(text.themeOptions).map(([value, optionLabel]) => (
                    <option key={value} value={value}>
                      {optionLabel}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <SettingsRow label={text.position}>
                <select
                  className="settings-select"
                  value={position}
                  disabled={!settings}
                  onChange={(event) =>
                    void changeSettings({
                      accountSelectorPosition: event.target.value as AccountSelectorPosition
                    })
                  }
                >
                  {ACCOUNT_SELECTOR_POSITION_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {text.positions[option]}
                    </option>
                  ))}
                </select>
              </SettingsRow>
              <h3 className="settings-group-title">{text.gmailCleanup}</h3>
              {GMAIL_CLEANUP_FIELDS.map((field) => (
                <SettingsRow key={field} label={text.gmailCleanupOptions[field]}>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    role="switch"
                    checked={settings?.[field] === true}
                    disabled={!settings}
                    onChange={(event) => void changeSettings({ [field]: event.target.checked })}
                  />
                </SettingsRow>
              ))}
              {settingsFailed && (
                <p className="settings-error" role="alert">
                  {text.settingsError}
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
      {activeIndex < 0 && !accounts && <main className="loading-state">{text.pending}</main>}
    </div>
  )
}

export default App
