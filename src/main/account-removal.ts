import type { AccountState } from '../shared/accounts'
import type { AccountRemovalOutcome, AccountRemovalResult } from '../shared/ipc'
import { isAccountId } from './account-state'

export interface AccountRemovalContext {
  ownerIsAlive: () => boolean
  confirm: (accountNumber: number) => Promise<boolean>
  disposeView: (accountId: string) => Promise<void>
  activate: (accountId: string) => void
}

interface AccountStore {
  getState: () => AccountState
  remove: (id: string) => AccountState
}

export function createAccountRemovalController(
  store: AccountStore,
  clearSession: (accountId: string) => Promise<void>,
  disconnectConnection: (accountId: string) => Promise<void> = async () => undefined
): {
  isBusy: () => boolean
  assertIdle: () => void
  remove: (accountId: string, context: AccountRemovalContext) => Promise<AccountRemovalResult>
  removeWhenIdle: (
    accountId: string,
    context: AccountRemovalContext
  ) => Promise<AccountRemovalResult>
} {
  let busy = false
  let queuedRemovals: Promise<void> = Promise.resolve()
  const queuedByAccount = new Map<string, Promise<AccountRemovalResult>>()
  const idleWaiters = new Set<() => void>()

  function assertIdle(): void {
    if (busy) throw new Error('Request rejected')
  }

  function result(outcome: AccountRemovalOutcome): AccountRemovalResult {
    return { outcome, state: store.getState() }
  }

  async function remove(
    accountId: string,
    context: AccountRemovalContext
  ): Promise<AccountRemovalResult> {
    assertIdle()
    if (!isAccountId(accountId)) throw new Error('Request rejected')
    const initial = store.getState()
    const index = initial.accounts.findIndex((account) => account.id === accountId)
    if (index < 0) throw new Error('Request rejected')
    busy = true
    try {
      if (!context.ownerIsAlive()) return result('cancelled')
      let confirmed: boolean
      try {
        confirmed = await context.confirm(index + 1)
      } catch {
        return result('failed')
      }
      if (!confirmed || !context.ownerIsAlive()) return result('cancelled')
      const current = store.getState()
      if (!current.accounts.some((account) => account.id === accountId)) return result('failed')
      let updated: AccountState
      try {
        await context.disposeView(accountId)
        await disconnectConnection(accountId)
        await clearSession(accountId)
        updated = store.remove(accountId)
      } catch {
        return result('failed')
      }
      if (
        initial.activeAccountId === accountId &&
        updated.activeAccountId &&
        context.ownerIsAlive()
      ) {
        try {
          context.activate(updated.activeAccountId)
        } catch {
          // Account removal is complete; view loading has its own status feedback.
        }
      }
      return { outcome: 'removed', state: updated }
    } finally {
      busy = false
      for (const resolve of idleWaiters) resolve()
      idleWaiters.clear()
    }
  }

  return {
    isBusy: () => busy,
    assertIdle,
    remove,
    removeWhenIdle(accountId, context) {
      if (!isAccountId(accountId)) return Promise.reject(new Error('Request rejected'))
      const existing = queuedByAccount.get(accountId)
      if (existing) return existing
      const pending: Promise<AccountRemovalResult> = queuedRemovals.then(async () => {
        while (busy) await new Promise<void>((resolve) => idleWaiters.add(resolve))
        if (!store.getState().accounts.some((account) => account.id === accountId))
          return { outcome: 'removed' as const, state: store.getState() }
        return remove(accountId, context)
      })
      queuedRemovals = pending.then(
        () => undefined,
        () => undefined
      )
      queuedByAccount.set(accountId, pending)
      const clearQueuedEntry = (): void => {
        if (queuedByAccount.get(accountId) === pending) queuedByAccount.delete(accountId)
      }
      void pending.then(clearQueuedEntry, clearQueuedEntry)
      return pending
    }
  }
}
