export interface GmailAccount {
  id: string
}

export interface AccountState {
  version: 1
  accounts: GmailAccount[]
  activeAccountId: string | null
}
