export interface GmailAccount {
  id: string
  email?: string | null
  displayName?: string | null
}

export interface AccountState {
  version: 1
  accounts: GmailAccount[]
  activeAccountId: string | null
  defaultAccountId: string | null
}
