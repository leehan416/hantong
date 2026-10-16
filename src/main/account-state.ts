import type { AccountState, GmailAccount } from '../shared/accounts'

export function isAccountId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseAccountState(value: unknown): AccountState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error('Invalid account data')
  }
  const accounts: GmailAccount[] = []
  const ids = new Set<string>()
  const entries: unknown[] = value.accounts
  for (const entry of entries) {
    if (!isRecord(entry) || !isAccountId(entry.id) || ids.has(entry.id)) {
      throw new Error('Invalid account data')
    }
    ids.add(entry.id)
    accounts.push({ id: entry.id })
  }
  const activeAccountId = value.activeAccountId
  if (activeAccountId !== null && !isAccountId(activeAccountId)) {
    throw new Error('Invalid account data')
  }
  if (
    accounts.length === 0
      ? activeAccountId !== null
      : activeAccountId === null || !ids.has(activeAccountId)
  ) {
    throw new Error('Invalid account data')
  }
  return { version: 1, accounts, activeAccountId }
}

export function addGmailAccount(state: AccountState, id: string): AccountState {
  if (!isAccountId(id) || state.accounts.some((account) => account.id === id)) {
    throw new Error('Invalid account data')
  }
  return parseAccountState({
    version: 1,
    accounts: [...state.accounts, { id }],
    activeAccountId: id
  })
}

export function activateGmailAccount(state: AccountState, id: string): AccountState {
  if (!state.accounts.some((account) => account.id === id)) throw new Error('Invalid account data')
  return parseAccountState({ ...state, activeAccountId: id })
}
