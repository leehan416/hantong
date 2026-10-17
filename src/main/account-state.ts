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

function isValidEmail(value: unknown): value is string {
  const pattern =
    /^[A-Z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}$/i
  return (
    typeof value === 'string' &&
    value.length <= 254 &&
    value.trim() === value &&
    value.split('@')[0].length <= 64 &&
    pattern.test(value)
  )
}

export function isValidGmailAccountDisplayName(value: unknown): value is string | null {
  if (value === null) return true
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 80 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || code === 127
    })
  )
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
    const account: GmailAccount = { id: entry.id }
    if (entry.email !== undefined) {
      if (entry.email !== null && !isValidEmail(entry.email)) {
        throw new Error('Invalid account data')
      }
      account.email = entry.email
    }
    if (entry.displayName !== undefined) {
      if (!isValidGmailAccountDisplayName(entry.displayName)) {
        throw new Error('Invalid account data')
      }
      account.displayName = entry.displayName
    }
    accounts.push(account)
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
  const defaultAccountId =
    value.defaultAccountId === undefined ? activeAccountId : value.defaultAccountId
  if (defaultAccountId !== null && !isAccountId(defaultAccountId)) {
    throw new Error('Invalid account data')
  }
  if (defaultAccountId !== null && !ids.has(defaultAccountId)) {
    throw new Error('Invalid account data')
  }
  if (accounts.length === 0 && defaultAccountId !== null) {
    throw new Error('Invalid account data')
  }
  return { version: 1, accounts, activeAccountId, defaultAccountId }
}

export function addGmailAccount(state: AccountState, id: string): AccountState {
  if (!isAccountId(id) || state.accounts.some((account) => account.id === id)) {
    throw new Error('Invalid account data')
  }
  return parseAccountState({
    version: 1,
    accounts: [...state.accounts, { id }],
    activeAccountId: id,
    defaultAccountId: state.defaultAccountId ?? id
  })
}

export function activateGmailAccount(state: AccountState, id: string): AccountState {
  if (!state.accounts.some((account) => account.id === id)) throw new Error('Invalid account data')
  return parseAccountState({ ...state, activeAccountId: id })
}

export function setGmailAccountDisplayName(
  state: AccountState,
  id: string,
  displayName: string | null
): AccountState {
  if (!isAccountId(id) || !state.accounts.some((account) => account.id === id)) {
    throw new Error('Invalid account data')
  }
  if (!isValidGmailAccountDisplayName(displayName)) {
    throw new Error('Invalid account data')
  }
  const accounts = state.accounts.map((account) =>
    account.id === id
      ? { ...account, displayName: displayName === null ? null : displayName.trim() }
      : account
  )
  return parseAccountState({ ...state, accounts })
}

export function recordVerifiedGmailEmail(
  state: AccountState,
  id: string,
  email: string
): AccountState {
  if (
    !isAccountId(id) ||
    !state.accounts.some((account) => account.id === id) ||
    !isValidEmail(email)
  ) {
    throw new Error('Invalid account data')
  }
  const accounts = state.accounts.map((account) =>
    account.id === id ? { ...account, email } : account
  )
  return parseAccountState({ ...state, accounts })
}

export function setDefaultGmailAccount(state: AccountState, id: string): AccountState {
  if (!isAccountId(id) || !state.accounts.some((account) => account.id === id)) {
    throw new Error('Invalid account data')
  }
  return parseAccountState({ ...state, defaultAccountId: id })
}

export function removeGmailAccount(state: AccountState, id: string): AccountState {
  const index = state.accounts.findIndex((account) => account.id === id)
  if (index < 0) throw new Error('Invalid account data')
  const accounts = state.accounts.filter((account) => account.id !== id)
  const activeAccountId =
    state.activeAccountId !== id
      ? state.activeAccountId
      : (accounts[index]?.id ?? accounts[index - 1]?.id ?? null)
  const defaultAccountId =
    state.defaultAccountId === id ? (accounts[0]?.id ?? null) : state.defaultAccountId
  return parseAccountState({ version: 1, accounts, activeAccountId, defaultAccountId })
}
