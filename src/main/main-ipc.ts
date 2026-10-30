import { app, dialog, ipcMain, nativeTheme, webContents, type BrowserWindow } from 'electron'
import { isAccountColor, type AccountState } from '../shared/accounts'
import type { AppSettingsPatch } from '../shared/settings'
import type { AppInfo } from '../shared/ipc'
import type { createAccountStore } from './account-store'
import type { createAccountRemovalController } from './account-removal'
import type { createAccountViewManager } from './account-view-manager'
import type { createSettingsStore } from './settings-store'
import type { createAccountAccessController } from './account-access-controller'
import type { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { createNotificationConnectionController } from './notification-connection-controller'
import type { createGmailCleanupRuntime } from './gmail-cleanup-runtime'
import type { createNotificationRecoveryRuntime } from './notification-recovery-runtime'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_MOVE_CHANNEL,
  ACCOUNT_DISPLAY_NAME_CHANNEL,
  ACCOUNT_COLOR_CHANNEL,
  ACCOUNT_NOTIFICATIONS_ENABLED_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_REMOVE_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STATUS_STRIP_CHANNEL,
  UNREAD_COUNTS_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  SETTINGS_EVENT,
  SETTINGS_PANEL_CHANNEL,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  GOOGLE_CONNECTION_CANCEL_CHANNEL,
  GOOGLE_CONNECTION_CONNECT_CHANNEL,
  GOOGLE_CONNECTION_DISCONNECT_CHANNEL,
  GOOGLE_CONNECTION_STATUS_CHANNEL,
  NOTIFICATION_CONNECTIONS_CHANNEL,
  NOTIFICATION_RECOVER_CHANNEL,
  NOTIFICATION_RECOVERY_CANCEL_CHANNEL,
  NOTIFICATION_RETRY_CHANNEL,
  ACCOUNT_ACCESS_STATE_CHANNEL,
  LOGIN_LAUNCH_GET_CHANNEL,
  LOGIN_LAUNCH_SET_CHANNEL
} from '../shared/ipc'
import {
  isAllowedAccountRequest,
  isAllowedAppInfoRequest,
  isAllowedGoogleConnectionRequest,
  isAllowedNotificationRequest,
  isAllowedSettingsRequest,
  isTrustedRendererUrl,
  isAllowedLoginLaunchRequest
} from './security-policy'
import type { createLoginLaunchController } from './login-launch'

export interface MainIpcDependencies {
  readonly rendererUrl: string
  readonly window: () => BrowserWindow | null
  readonly views: () => ReturnType<typeof createAccountViewManager> | null
  readonly access: () => ReturnType<typeof createAccountAccessController> | null
  readonly notifications: () => ReturnType<typeof createNotificationConnectionController> | null
  readonly settings: () => ReturnType<typeof createSettingsStore> | null
  readonly isQuitting: () => boolean
  readonly requireAccountStore: () => ReturnType<typeof createAccountStore>
  readonly requireAccountRemoval: () => ReturnType<typeof createAccountRemovalController>
  readonly requireGoogleRuntime: () => ReturnType<typeof createGoogleConnectionRuntime>
  readonly recovery: ReturnType<typeof createNotificationRecoveryRuntime>
  readonly gmailCleanup: ReturnType<typeof createGmailCleanupRuntime>
  readonly unreadCounts: () => { unreadCounts: () => ReadonlyMap<string, number> }
  readonly locale: () => 'ko' | 'en'
  readonly activateView: (accountId: string) => void
  readonly publishAccountState: (owner: BrowserWindow, state: AccountState) => void
  readonly installAppMenu: () => void
  readonly createWindow: () => void
  readonly loginLaunch: ReturnType<typeof createLoginLaunchController>
}

export function registerMainIpc(dependencies: MainIpcDependencies): void {
  for (const [channel, operation] of [
    [LOGIN_LAUNCH_GET_CHANNEL, 'get'],
    [LOGIN_LAUNCH_SET_CHANNEL, 'set']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const request = {
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      }
      if (!isAllowedLoginLaunchRequest(request, operation)) throw new Error('Request rejected')
      return operation === 'get'
        ? dependencies.loginLaunch.getState()
        : dependencies.loginLaunch.setEnabled(args[0] as boolean)
    })
  }
  ipcMain.handle(APP_INFO_CHANNEL, (event, ...args: unknown[]): AppInfo => {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    if (
      !isAllowedAppInfoRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      })
    ) {
      throw new Error('Request rejected')
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      locale: app.getLocale().startsWith('ko') ? 'ko' : 'en'
    }
  })

  function accountRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation:
      | 'get'
      | 'add'
      | 'activate'
      | 'retry'
      | 'remove'
      | 'setDisplayName'
      | 'setColor'
      | 'setNotificationsEnabled'
      | 'move',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = typeof args[0] === 'string' ? args[0] : ''
    const state = dependencies.requireAccountStore().getState()
    return isAllowedAccountRequest({
      ownerAlive,
      senderMatches: ownerAlive && event.sender === owner.webContents,
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      operation,
      args,
      accountExists:
        operation === 'activate' ||
        operation === 'remove' ||
        operation === 'setDisplayName' ||
        operation === 'setColor' ||
        operation === 'setNotificationsEnabled' ||
        operation === 'move'
          ? state.accounts.some((account) => account.id === id)
          : operation === 'retry' && state.activeAccountId !== null
    })
  }

  function googleConnectionRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'connect' | 'cancel' | 'disconnect',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = args.length === 1 && typeof args[0] === 'string' ? args[0] : ''
    const accountExists = dependencies
      .requireAccountStore()
      .getState()
      .accounts.some((account) => account.id === id)
    return (
      !dependencies.isQuitting() &&
      !dependencies.requireAccountRemoval().isBusy() &&
      isAllowedGoogleConnectionRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args,
        accountExists
      })
    )
  }

  function notificationRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'recover' | 'cancel' | 'retry',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = typeof args[0] === 'string' ? args[0] : ''
    const accountExists = dependencies
      .requireAccountStore()
      .getState()
      .accounts.some((account) => account.id === id)
    return (
      !dependencies.isQuitting() &&
      !dependencies.requireAccountRemoval().isBusy() &&
      isAllowedNotificationRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args,
        accountExists
      })
    )
  }

  ipcMain.handle(NOTIFICATION_CONNECTIONS_CHANNEL, (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    return dependencies.notifications()?.snapshot() ?? {}
  })
  ipcMain.handle(NOTIFICATION_RECOVER_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'recover', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.recover(args[0])
  })
  ipcMain.handle(NOTIFICATION_RECOVERY_CANCEL_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'cancel', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.cancel(args[0])
  })
  ipcMain.handle(NOTIFICATION_RETRY_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'retry', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.retry(args[0])
  })

  const handleGoogleConnection = (
    channel: string,
    operation: 'get' | 'connect' | 'cancel' | 'disconnect'
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!googleConnectionRequestAllowed(event, operation, args))
        throw new Error('Request rejected')
      const accountId = args[0]
      const owner = dependencies.window()
      if (typeof accountId !== 'string' || !owner) throw new Error('Request rejected')
      const runtime = dependencies.requireGoogleRuntime()
      const accessController = dependencies.access()
      let result: Awaited<ReturnType<typeof runtime.getStatus>>
      if (operation === 'get') {
        result = await runtime.getStatus(accountId)
      } else {
        if (!accessController) throw new Error('Request rejected')
        const accessResult =
          operation === 'connect'
            ? await accessController.connect(accountId)
            : operation === 'cancel'
              ? await accessController.cancel(accountId)
              : await accessController.disconnect(accountId)
        result = { accountId, status: accessResult.connectionStatus }
      }
      if (
        dependencies.window() !== owner ||
        owner.isDestroyed() ||
        event.sender !== owner.webContents ||
        event.senderFrame === null ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, dependencies.rendererUrl) ||
        !dependencies
          .requireAccountStore()
          .getState()
          .accounts.some((account) => account.id === accountId)
      )
        throw new Error('Request rejected')
      return result
    })
  }
  handleGoogleConnection(GOOGLE_CONNECTION_STATUS_CHANNEL, 'get')
  handleGoogleConnection(GOOGLE_CONNECTION_CONNECT_CHANNEL, 'connect')
  handleGoogleConnection(GOOGLE_CONNECTION_CANCEL_CHANNEL, 'cancel')
  handleGoogleConnection(GOOGLE_CONNECTION_DISCONNECT_CHANNEL, 'disconnect')

  ipcMain.handle(ACCOUNT_ACCESS_STATE_CHANNEL, (event, ...args: unknown[]) => {
    if (!googleConnectionRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const access = dependencies.access()
    if (typeof accountId !== 'string' || !access) throw new Error('Request rejected')
    return access.getState(accountId)
  })

  function settingsRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'update' | 'panel' | 'status-strip',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    return isAllowedSettingsRequest({
      ownerAlive,
      senderMatches: ownerAlive && event.sender === owner.webContents,
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      operation,
      args
    })
  }
  ipcMain.handle(SETTINGS_GET_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'get', args)) {
      throw new Error('Request rejected')
    }
    const settingsStore = dependencies.settings()
    if (!settingsStore) throw new Error('Request rejected')
    return settingsStore.get()
  })
  ipcMain.handle(SETTINGS_UPDATE_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'update', args)) {
      throw new Error('Request rejected')
    }
    const settingsStore = dependencies.settings()
    if (!settingsStore) throw new Error('Request rejected')
    const settings = settingsStore.update(args[0] as AppSettingsPatch) // validated by the policy
    nativeTheme.themeSource = settings.theme
    dependencies.views()?.setLayout(settings.accountSelectorPosition, settings.sidebarCollapsed)
    for (const contents of webContents.getAllWebContents())
      dependencies.gmailCleanup.apply(contents)
    dependencies.installAppMenu()
    const owner = dependencies.window()
    if (owner && !owner.isDestroyed()) owner.webContents.send(SETTINGS_EVENT, settings)
    return settings
  })
  ipcMain.handle(SETTINGS_PANEL_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'panel', args)) throw new Error('Request rejected')
    return dependencies.views()?.setCovered(args[0] === true) ?? null
  })
  ipcMain.handle(ACCOUNT_STATUS_STRIP_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'status-strip', args)) throw new Error('Request rejected')
    dependencies.views()?.setStatusStripVisible(args[0] === true)
  })
  ipcMain.handle(UNREAD_COUNTS_CHANNEL, (event, ...args: unknown[]) => {
    if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    return Object.fromEntries(dependencies.unreadCounts().unreadCounts())
  })
  ipcMain.handle(ACCOUNT_STATE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().getState()
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_ADD_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'add', args)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().add()
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_ACTIVATE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'activate', args)) throw new Error('Request rejected')
    const id = args[0]
    if (typeof id !== 'string') throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().activate(id)
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_DISPLAY_NAME_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setDisplayName', args)) {
      throw new Error('Request rejected')
    }
    const accountId = args[0]
    const displayName = args[1]
    if (
      typeof accountId !== 'string' ||
      (displayName !== null && typeof displayName !== 'string')
    ) {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setDisplayName(accountId, displayName)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_COLOR_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setColor', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const color = args[1]
    if (typeof accountId !== 'string' || typeof color !== 'string')
      throw new Error('Request rejected')
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    if (!isAccountColor(color)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setColor(accountId, color)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_NOTIFICATIONS_ENABLED_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setNotificationsEnabled', args)) {
      throw new Error('Request rejected')
    }
    const [accountId, enabled] = args
    if (typeof accountId !== 'string' || typeof enabled !== 'boolean') {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setNotificationsEnabled(accountId, enabled)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_MOVE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'move', args)) throw new Error('Request rejected')
    const [accountId, toIndex] = args
    if (typeof accountId !== 'string' || typeof toIndex !== 'number') {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().move(accountId, toIndex)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_RETRY_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'retry', args)) throw new Error('Request rejected')
    dependencies.views()?.retry()
  })
  ipcMain.handle(ACCOUNT_REMOVE_CHANNEL, async (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'remove', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const owner = dependencies.window()
    const viewManager = dependencies.views()
    if (typeof accountId !== 'string' || !owner || !viewManager) {
      throw new Error('Request rejected')
    }
    const ownerIsAlive = (): boolean => dependencies.window() === owner && !owner.isDestroyed()
    const result = await dependencies.requireAccountRemoval().remove(accountId, {
      ownerIsAlive,
      async confirm(): Promise<boolean> {
        if (!ownerIsAlive()) return false
        const isKorean = dependencies.locale() === 'ko'
        const response = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: isKorean ? '계정 삭제' : 'Remove account',
          message: isKorean ? '계정을 삭제할까요?' : 'Remove this account?',
          detail: isKorean
            ? '이 기기의 로그인 정보와 세션을 삭제합니다. Google 계정과 메일은 삭제되지 않습니다.'
            : 'This removes its local sign-in and session from this device. Your Google account and email are not deleted.',
          buttons: isKorean ? ['취소', '계정 삭제'] : ['Cancel', 'Remove account'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return response.response === 1
      },
      disposeView: (id) => viewManager.disposeAccount(id),
      activate: (id) => {
        if (!ownerIsAlive()) return
        try {
          viewManager.activate(id)
        } catch {
          if (!owner.isDestroyed()) {
            owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId: id, status: 'error' })
          }
        }
      }
    })
    if (result.outcome === 'removed' && typeof accountId === 'string') {
      viewManager.forgetLogoutLock(accountId)
      dependencies.access()?.forget(accountId)
      dependencies.recovery.clearPending(accountId)
      dependencies.notifications()?.disconnect(accountId)
    }
    if (result.outcome === 'failed' && ownerIsAlive()) {
      owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
    }
    return result
  })
}
