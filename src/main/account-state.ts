import {
  isAccountColor,
  MAX_ACCOUNTS,
  type AccountColor,
  type AccountState,
  type GmailAccount
} from '../shared/accounts'

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
    if (entry.color !== undefined) {
      if (!isAccountColor(entry.color)) throw new Error('Invalid account data')
      account.color = entry.color
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
  // Older files may carry a `defaultAccountId`; the first account now plays that role.
  return { version: 1, accounts, activeAccountId }
}

export function addGmailAccount(state: AccountState, id: string): AccountState {
  if (!isAccountId(id) || state.accounts.some((account) => account.id === id)) {
    throw new Error('Invalid account data')
  }
  if (state.accounts.length >= MAX_ACCOUNTS) throw new Error('Account limit reached')
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

export function setGmailAccountColor(
  state: AccountState,
  id: string,
  color: AccountColor
): AccountState {
  if (
    !isAccountId(id) ||
    !state.accounts.some((account) => account.id === id) ||
    !isAccountColor(color)
  ) {
    throw new Error('Invalid account data')
  }
  const accounts = state.accounts.map((account) =>
    account.id === id ? { ...account, color } : account
  )
  return parseAccountState({ ...state, accounts })
}

export function recordWebIdentityGmailEmail(
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

export function moveGmailAccount(state: AccountState, id: string, toIndex: number): AccountState {
  const from = state.accounts.findIndex((account) => account.id === id)
  if (from < 0 || !Number.isInteger(toIndex) || toIndex < 0 || toIndex >= state.accounts.length) {
    throw new Error('Invalid account data')
  }
  const accounts = [...state.accounts]
  accounts.splice(toIndex, 0, ...accounts.splice(from, 1))
  return parseAccountState({ ...state, accounts })
}

export function removeGmailAccount(state: AccountState, id: string): AccountState {
  const index = state.accounts.findIndex((account) => account.id === id)
  if (index < 0) throw new Error('Invalid account data')
  const accounts = state.accounts.filter((account) => account.id !== id)
  const activeAccountId =
    state.activeAccountId !== id
      ? state.activeAccountId
      : (accounts[index]?.id ?? accounts[index - 1]?.id ?? null)
  return parseAccountState({ version: 1, accounts, activeAccountId })
}
