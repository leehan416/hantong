import { dialog, type BrowserWindow } from 'electron'
import type { createAccountStore } from './account-store'
import type { createAccountViewManager } from './account-view-manager'
import type { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { createAccountRemovalController } from './account-removal'
import type { createNotificationConnectionController } from './notification-connection-controller'

type PendingNotificationRecovery = {
  started: boolean
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

export interface NotificationRecoveryDependencies {
  readonly window: () => BrowserWindow | null
  readonly googleRuntime: () => ReturnType<typeof createGoogleConnectionRuntime> | null
  readonly views: () => ReturnType<typeof createAccountViewManager> | null
  readonly accessController: () => ReturnType<
    typeof import('./account-access-controller').createAccountAccessController
  > | null
  readonly notificationController: () => ReturnType<
    typeof createNotificationConnectionController
  > | null
  readonly accountRemoval: () => ReturnType<typeof createAccountRemovalController> | null
  readonly accountStore: () => ReturnType<typeof createAccountStore> | null
  readonly isQuitting: () => boolean
  readonly locale: () => 'ko' | 'en'
  readonly showAccount: (accountId: string) => void
}

export function createNotificationRecoveryRuntime(dependencies: NotificationRecoveryDependencies): {
  startPending(accountId: string): void
  clearPending(accountId: string): void
  request(accountId: string): Promise<void>
  showDialog(accountId: string, status: 'reconnect_required' | 'storage_error'): void
  hasPending(accountId?: string): boolean
  pendingAccountIds(): IterableIterator<string>
  failPending(accountId: string, error: Error): void
  resolveAll(): void
  isDialogActive(): boolean
} {
  const pendingNotificationRecoveries = new Map<string, PendingNotificationRecovery>()
  let notificationDialogActive = false

  function startPending(accountId: string): void {
    const pending = pendingNotificationRecoveries.get(accountId)
    const runtime = dependencies.googleRuntime()
    const views = dependencies.views()
    if (!pending || pending.started || !runtime || !views || dependencies.isQuitting()) return
    if (views.getActiveAccountId() !== accountId || !views.getDocumentState(accountId).ready) return
    pending.started = true
    void runtime
      .connect(accountId)
      .then((status) => {
        if (status.status === 'error' || status.status === 'disconnected') {
          pending.reject(new Error('Notification recovery did not complete'))
          return
        }
        pending.resolve()
        dependencies.accessController()?.onViewReady(accountId)
      })
      .catch((error: unknown) => {
        pending.reject(error instanceof Error ? error : new Error('Notification recovery failed'))
      })
      .finally(() => {
        if (pendingNotificationRecoveries.get(accountId) === pending)
          pendingNotificationRecoveries.delete(accountId)
        dependencies.notificationController()?.flushAlerts()
      })
  }

  function clearPending(accountId: string): void {
    const pending = pendingNotificationRecoveries.get(accountId)
    if (!pending) return
    pendingNotificationRecoveries.delete(accountId)
    pending.reject(new Error('Notification recovery was cancelled'))
    dependencies.notificationController()?.flushAlerts()
  }

  function showDialog(accountId: string, status: 'reconnect_required' | 'storage_error'): void {
    const owner = dependencies.window()
    if (
      !owner ||
      owner.isDestroyed() ||
      !owner.isVisible() ||
      dependencies.isQuitting() ||
      notificationDialogActive
    )
      return
    const korean = dependencies.locale() === 'ko'
    const reconnect = status === 'reconnect_required'
    const accounts = dependencies.accountStore()?.getState().accounts ?? []
    const accountIndex = accounts.findIndex((account) => account.id === accountId)
    const accountLabel =
      accountIndex >= 0
        ? accounts[accountIndex].displayName?.trim() || `Gmail ${accountIndex + 1}`
        : 'Gmail'
    notificationDialogActive = true
    void dialog
      .showMessageBox(owner, {
        type: 'warning',
        title: korean ? '실시간 알림 연결' : 'Notification connection',
        message: reconnect
          ? korean
            ? `${accountLabel}: 실시간 알림을 복구하려면 Google 인증이 필요합니다.`
            : `${accountLabel}: Google sign-in is needed to restore real-time notifications.`
          : korean
            ? `${accountLabel}: 알림 연결 정보를 불러오거나 저장하지 못했습니다.`
            : `${accountLabel}: Notification connection data could not be read or saved.`,
        buttons: korean
          ? [reconnect ? '알림 연결 복구' : '다시 시도', '나중에']
          : [reconnect ? 'Recover notifications' : 'Try again', 'Later'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      .then(({ response }) => {
        if (response === 0) {
          const controller = dependencies.notificationController()
          if (reconnect) void controller?.recover(accountId).catch(() => undefined)
          else void controller?.retry(accountId).catch(() => undefined)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        notificationDialogActive = false
        dependencies.notificationController()?.flushAlerts()
      })
  }

  function request(accountId: string): Promise<void> {
    const accountStore = dependencies.accountStore()
    if (
      dependencies.isQuitting() ||
      dependencies.accountRemoval()?.isBusy() ||
      !accountStore?.getState().accounts.some((account) => account.id === accountId)
    ) {
      return Promise.reject(new Error('Notification recovery is unavailable'))
    }
    const existing = pendingNotificationRecoveries.get(accountId)
    if (existing) return existing.promise
    let resolve: (() => void) | undefined
    let reject: ((error: Error) => void) | undefined
    const promise = new Promise<void>((onResolve, onReject) => {
      resolve = onResolve
      reject = onReject
    })
    pendingNotificationRecoveries.set(accountId, {
      started: false,
      promise,
      resolve: () => resolve?.(),
      reject: (error) => reject?.(error)
    })
    dependencies.showAccount(accountId)
    startPending(accountId)
    // Activation loads the view; its ready callback starts this explicitly requested flow.
    return promise
  }

  function failPending(accountId: string, error: Error): void {
    const pending = pendingNotificationRecoveries.get(accountId)
    if (!pending) return
    pendingNotificationRecoveries.delete(accountId)
    pending.reject(error)
    dependencies.notificationController()?.flushAlerts()
  }

  function resolveAll(): void {
    for (const pending of pendingNotificationRecoveries.values()) pending.resolve()
    pendingNotificationRecoveries.clear()
  }

  return {
    startPending,
    clearPending,
    request,
    showDialog,
    hasPending: (accountId) =>
      accountId === undefined
        ? pendingNotificationRecoveries.size > 0
        : pendingNotificationRecoveries.has(accountId),
    pendingAccountIds: () => pendingNotificationRecoveries.keys(),
    failPending,
    resolveAll,
    isDialogActive: () => notificationDialogActive
  }
}
