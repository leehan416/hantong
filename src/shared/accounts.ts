// Adding past this is refused; the limit is enforced, not advertised.
export const MAX_ACCOUNTS = 10

export const ACCOUNT_COLOR_OPTIONS = ['blue', 'purple', 'green', 'orange', 'gray'] as const
export type AccountColor = (typeof ACCOUNT_COLOR_OPTIONS)[number]

export function isAccountColor(value: unknown): value is AccountColor {
  return typeof value === 'string' && ACCOUNT_COLOR_OPTIONS.some((color) => color === value)
}

export interface GmailAccount {
  id: string
  email?: string | null
  displayName?: string | null
  color?: AccountColor
}

export interface AccountState {
  version: 1
  accounts: GmailAccount[]
  activeAccountId: string | null
}

export function accountLabel(account: GmailAccount, index: number): string {
  return account.displayName?.trim() || account.email?.trim() || `Gmail ${index + 1}`
}
