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
} {
  let busy = false

  function assertIdle(): void {
    if (busy) throw new Error('Request rejected')
  }

  function result(outcome: AccountRemovalOutcome): AccountRemovalResult {
    return { outcome, state: store.getState() }
  }

  return {
    isBusy: () => busy,
    assertIdle,
    async remove(accountId, context): Promise<AccountRemovalResult> {
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
      }
    }
  }
}
