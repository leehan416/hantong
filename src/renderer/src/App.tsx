import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getAccountViewBounds } from '../../shared/account-layout'
import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH
} from '../../shared/ipc'
import { AccountCardNavigation, SidebarAccountNavigation } from './AccountSelector'
import { IconActionButton } from './IconActionButton'
import { messages } from './app-messages'
import { SettingsDialog, type SettingsSection } from './SettingsDialog'
import { GeneralSettings } from './GeneralSettings'
import { AccountSettings } from './AccountSettings'
import { AppearanceSettings } from './AppearanceSettings'
import { AccountAccessGate } from './AccountAccessGate'
import { NotificationStatusStrip, type StatusAction } from './NotificationStatusStrip'
import { useAppAccounts } from './use-app-accounts'
import { useAppConnections } from './use-app-connections'
import { useAppSettings } from './use-app-settings'

function App(): React.JSX.Element {
  const accountData = useAppAccounts()
  const activeAccountId = accountData.accounts?.activeAccountId ?? null
  const connections = useAppConnections(activeAccountId, accountData.busy)
  const settingsState = useAppSettings()
  const {
    info,
    accounts,
    viewStatus,
    busy,
    unreadCounts,
    operationFailed,
    removalFailed,
    accountLimitReached,
    accountSettingsFailed,
    setAccountSettingsFailed,
    accountNameDrafts,
    setAccountNameDrafts,
    accountSettingsBusy,
    setAccountSettingsBusy,
    accountNameSaveFailed,
    setAccountNameSaveFailed,
    editingAccountId,
    setEditingAccountId,
    nameEditCancelledRef,
    setAccounts,
    addAccount,
    activateAccount,
    moveAccount,
    removeAccount,
    retry
  } = accountData
  const {
    googleStates,
    notificationRecoveryState,
    accessState,
    notificationRecoveryController,
    accessController,
    accountActionsBusy,
    reconnectFromGate,
    cancelFromGate,
    reopenFromGate
  } = connections
  const {
    settings,
    settingsOpen,
    settingsBackground,
    settingsPanelFailed,
    settingsFailed,
    settingsSection,
    settingsDialogRef,
    settingsButtonRef,
    openSettings,
    closeSettings,
    changeSettings,
    setSettingsSection
  } = settingsState
  const [statusStripLayoutVisible, setStatusStripLayoutVisible] = useState(true)
  const statusStripLayoutRevision = useRef(0)
  const locale =
    settings && settings.language !== 'system'
      ? settings.language
      : (info?.locale ?? (navigator.language.startsWith('ko') ? 'ko' : 'en'))
  const text = messages[locale]
  const sectionTitles: Record<SettingsSection, string> = {
    general: text.settingsGeneral,
    accounts: text.settingsAccounts,
    appearance: text.settingsAppearance
  }
  const position = settings?.accountSelectorPosition ?? 'top'
  const sidebarCollapsed = settings?.sidebarCollapsed ?? false
  const activeIndex =
    accounts?.accounts.findIndex((account) => account.id === activeAccountId) ?? -1
  const currentStatus = viewStatus?.accountId === activeAccountId ? viewStatus.status : null
  const googleState = activeAccountId ? googleStates[activeAccountId] : undefined
  const googleOperation = googleState?.operation ?? null
  const access = accessState.accountId === activeAccountId ? accessState.state : null
  const gateVisible = Boolean(
    activeAccountId && access?.status !== 'sign_in' && access?.status !== 'ready'
  )

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

  // The strip only appears for something the user can act on; loading progress stays silent.
  const selectedNotificationState =
    notificationRecoveryState.accountId === activeAccountId
      ? notificationRecoveryState.notification
      : null
  let statusMessage = ''
  if (currentStatus === 'error') statusMessage = text.error
  else if (currentStatus === 'blocked') statusMessage = text.blocked
  if (removalFailed) statusMessage = text.removeError
  if (operationFailed) statusMessage = text.operationError
  let statusAction: StatusAction =
    currentStatus === 'error' || currentStatus === 'blocked' || (operationFailed && !removalFailed)
      ? 'view-retry'
      : null
  if (!statusMessage && selectedNotificationState) {
    if (notificationRecoveryState.operationFailed) statusMessage = text.notificationActionError
    if (
      notificationRecoveryState.operation === 'recovering' ||
      notificationRecoveryState.operation === 'cancelling' ||
      selectedNotificationState.recovering
    ) {
      if (!notificationRecoveryState.operationFailed) statusMessage = text.notificationRecovering
      statusAction = 'notification-cancel'
    } else {
      switch (selectedNotificationState.status) {
        case 'reconnect_required':
          if (!notificationRecoveryState.operationFailed)
            statusMessage = text.notificationReconnectRequired
          statusAction = 'notification-recover'
          break
        case 'storage_error':
          if (!notificationRecoveryState.operationFailed)
            statusMessage = text.notificationStorageError
          statusAction = 'notification-retry'
          break
        case 'connecting':
        case 'retrying':
          if (!notificationRecoveryState.operationFailed) statusMessage = text.notificationRetrying
          statusAction = 'notification-retry'
          break
        case 'unavailable':
          if (!notificationRecoveryState.operationFailed)
            statusMessage = text.notificationUnavailable
          statusAction = 'notification-retry'
          break
      }
      if (notificationRecoveryState.operationFailed && statusAction === null) {
        statusAction = 'notification-retry'
      }
    }
  }
  const showStatusStrip = Boolean(statusMessage)
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
          <NotificationStatusStrip
            message={statusMessage}
            action={statusAction}
            busy={accountActionsBusy}
            recoveryState={notificationRecoveryState}
            text={text}
            onRetry={() => void retry()}
            onRecover={() => void notificationRecoveryController.current?.recover()}
            onCancel={() => void notificationRecoveryController.current?.cancel()}
            onNotificationRetry={() => void notificationRecoveryController.current?.retry()}
          />
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
      <SettingsDialog
        dialogRef={settingsDialogRef}
        section={settingsSection}
        sectionTitles={sectionTitles}
        text={text}
        panelFailed={settingsPanelFailed}
        onSectionChange={setSettingsSection}
        onClose={() => void closeSettings()}
      >
        {settingsSection === 'general' ? (
          <GeneralSettings
            settings={settings}
            text={text}
            failed={settingsFailed}
            onChange={changeSettings}
          />
        ) : settingsSection === 'accounts' ? (
          <AccountSettings
            accounts={accounts}
            text={text}
            accountActionsBusy={accountActionsBusy}
            accountNameDrafts={accountNameDrafts}
            setAccountNameDrafts={setAccountNameDrafts}
            accountSettingsBusy={accountSettingsBusy}
            setAccountSettingsBusy={setAccountSettingsBusy}
            accountSettingsFailed={accountSettingsFailed}
            setAccountSettingsFailed={setAccountSettingsFailed}
            accountNameSaveFailed={accountNameSaveFailed}
            setAccountNameSaveFailed={setAccountNameSaveFailed}
            editingAccountId={editingAccountId}
            setEditingAccountId={setEditingAccountId}
            nameEditCancelledRef={nameEditCancelledRef}
            accountLimitReached={accountLimitReached}
            onAdd={() => void addAccount()}
            onRemove={(accountId) => void removeAccount(accountId, connections.removeAccount)}
            onAccountsChange={setAccounts}
          />
        ) : (
          <AppearanceSettings
            settings={settings}
            position={position}
            text={text}
            failed={settingsFailed}
            onChange={changeSettings}
          />
        )}
      </SettingsDialog>
      {!settingsOpen && accounts?.accounts.length === 0 && (
        <main className="empty-state">
          <p>{text.welcome}</p>
        </main>
      )}
      {!settingsOpen && gateVisible && activeAccountId && (
        <AccountAccessGate
          accessState={accessState}
          access={access}
          busy={busy}
          googleOperation={googleOperation}
          text={text}
          onRetry={() => void accessController.current?.refresh()}
          onCancel={() => void cancelFromGate()}
          onReconnect={() => void reconnectFromGate()}
          onReopen={() => void reopenFromGate()}
        />
      )}
      {activeIndex < 0 && !accounts && <main className="loading-state">{text.pending}</main>}
    </div>
  )
}

export default App
