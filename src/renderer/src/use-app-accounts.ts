import { useEffect, useRef, useState } from 'react'
import type { AccountState } from '../../shared/accounts'
import { MAX_ACCOUNTS } from '../../shared/accounts'
import type { AccountViewStatus, AppInfo, UnreadCounts } from '../../shared/ipc'

export function useAppAccounts(): {
  info: AppInfo | null
  accounts: AccountState | null
  viewStatus: AccountViewStatus | null
  busy: boolean
  unreadCounts: UnreadCounts
  operationFailed: boolean
  removalFailed: boolean
  accountLimitReached: boolean
  accountSettingsFailed: boolean
  setAccountSettingsFailed: React.Dispatch<React.SetStateAction<boolean>>
  accountNameDrafts: Record<string, string>
  setAccountNameDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>
  accountSettingsBusy: string | null
  setAccountSettingsBusy: React.Dispatch<React.SetStateAction<string | null>>
  accountNameSaveFailed: boolean
  setAccountNameSaveFailed: React.Dispatch<React.SetStateAction<boolean>>
  editingAccountId: string | null
  setEditingAccountId: React.Dispatch<React.SetStateAction<string | null>>
  nameEditCancelledRef: React.RefObject<boolean>
  setAccounts: (state: AccountState) => void
  setOperationFailed: (failed: boolean) => void
  setRemovalFailed: (failed: boolean) => void
  setAccountLimitReached: (reached: boolean) => void
  addAccount: () => Promise<void>
  activateAccount: (accountId: string) => Promise<void>
  moveAccount: (accountId: string, toIndex: number) => Promise<void>
  removeAccount: (
    accountId: string,
    onAccountRemoved: (accountId: string, removed: boolean) => void
  ) => Promise<void>
  retry: () => Promise<void>
} {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [accounts, setAccounts] = useState<AccountState | null>(null)
  const [viewStatus, setViewStatus] = useState<AccountViewStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<UnreadCounts>({})
  const [operationFailed, setOperationFailed] = useState(false)
  const [removalFailed, setRemovalFailed] = useState(false)
  const [accountLimitReached, setAccountLimitReached] = useState(false)
  const [accountSettingsFailed, setAccountSettingsFailed] = useState(false)
  const [accountNameDrafts, setAccountNameDrafts] = useState<Record<string, string>>({})
  const [accountSettingsBusy, setAccountSettingsBusy] = useState<string | null>(null)
  const [accountNameSaveFailed, setAccountNameSaveFailed] = useState(false)
  const [editingAccountId, setEditingAccountId] = useState<string | null>(null)
  const nameEditCancelledRef = useRef(false)

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

  const activeAccountId = accounts?.activeAccountId ?? null

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

  async function removeAccount(
    accountId: string,
    onAccountRemoved: (accountId: string, removed: boolean) => void
  ): Promise<void> {
    setBusy(true)
    setOperationFailed(false)
    setRemovalFailed(false)
    setAccountSettingsFailed(false)
    try {
      const result = await window.api.removeAccount(accountId)
      onAccountRemoved(accountId, result.outcome === 'removed')
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

  return {
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
    setOperationFailed,
    setRemovalFailed,
    setAccountLimitReached,
    addAccount,
    activateAccount,
    moveAccount,
    removeAccount,
    retry
  }
}
