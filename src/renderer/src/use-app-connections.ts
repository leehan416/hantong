import { useEffect, useRef, useState } from 'react'
import type { AccountAccessState } from '../../shared/ipc'
import {
  AccountAccessController,
  type AccountAccessUiState,
  GoogleConnectionControllerPool,
  hasPendingGoogleConnection,
  type GoogleConnectionUiState
} from './google-connection-controller'
import {
  NotificationRecoveryController,
  type NotificationRecoveryUiState
} from './notification-recovery-controller'

export function useAppConnections(
  activeAccountId: string | null,
  busy: boolean
): {
  googleStates: Record<string, GoogleConnectionUiState>
  notificationRecoveryState: NotificationRecoveryUiState
  accessState: AccountAccessUiState
  googleControllerPool: React.RefObject<GoogleConnectionControllerPool | null>
  notificationRecoveryController: React.RefObject<NotificationRecoveryController | null>
  accessController: React.RefObject<AccountAccessController | null>
  accountActionsBusy: boolean
  reconnectFromGate: () => Promise<void>
  reopenFromGate: () => Promise<void>
  cancelFromGate: () => Promise<void>
  removeAccount: (accountId: string, removed: boolean) => void
  setGoogleStates: React.Dispatch<React.SetStateAction<Record<string, GoogleConnectionUiState>>>
} {
  const [googleStates, setGoogleStates] = useState<Record<string, GoogleConnectionUiState>>({})
  const [notificationRecoveryState, setNotificationRecoveryState] =
    useState<NotificationRecoveryUiState>({
      accountId: null,
      notification: null,
      operation: null,
      operationFailed: false
    })
  const [accessState, setAccessState] = useState<AccountAccessUiState>({
    accountId: null,
    state: null,
    loading: false,
    readFailed: false
  })
  const googleControllerPool = useRef<GoogleConnectionControllerPool | null>(null)
  const notificationRecoveryController = useRef<NotificationRecoveryController | null>(null)
  const accessController = useRef<AccountAccessController | null>(null)
  const activeAccountIdRef = useRef(activeAccountId)

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
    const controller = new NotificationRecoveryController(window.api, setNotificationRecoveryState)
    notificationRecoveryController.current = controller
    return () => {
      controller.dispose()
      if (notificationRecoveryController.current === controller) {
        notificationRecoveryController.current = null
      }
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
    activeAccountIdRef.current = activeAccountId
    if (activeAccountId) googleControllerPool.current?.forAccount(activeAccountId)
    accessController.current?.selectAccount(activeAccountId)
    notificationRecoveryController.current?.selectAccount(activeAccountId)
  }, [activeAccountId])

  const access = accessState.accountId === activeAccountId ? accessState.state : null
  const accountActionsBusy =
    busy ||
    hasPendingGoogleConnection(Object.values(googleStates)) ||
    access?.connectionStatus === 'connecting'

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

  async function reopenFromGate(): Promise<void> {
    if (!activeAccountId) return
    const accountId = activeAccountId
    const controller = googleControllerPool.current?.forAccount(accountId)
    if (!controller) return
    await controller.restart(() => activeAccountIdRef.current === accountId)
    if (activeAccountIdRef.current === accountId) await accessController.current?.refresh()
  }

  function removeAccount(accountId: string, removed: boolean): void {
    googleControllerPool.current?.remove(accountId)
    if (removed) {
      notificationRecoveryController.current?.removeAccount(accountId)
    }
    setGoogleStates((states) => {
      const next = { ...states }
      delete next[accountId]
      return next
    })
  }

  return {
    googleStates,
    notificationRecoveryState,
    accessState,
    googleControllerPool,
    notificationRecoveryController,
    accessController,
    accountActionsBusy,
    reconnectFromGate,
    reopenFromGate,
    cancelFromGate,
    removeAccount,
    setGoogleStates
  }
}
