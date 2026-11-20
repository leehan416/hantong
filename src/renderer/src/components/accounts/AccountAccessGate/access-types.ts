import type { AccountAccessState, GoogleConnectionStatus } from '~/shared/ipc'

export interface AccountAccessUiState {
  accountId: string | null
  state: AccountAccessState | null
  loading: boolean
  readFailed: boolean
}

export interface GoogleConnectionUiState {
  accountId: string | null
  status: GoogleConnectionStatus['status'] | null
  loading: boolean
  readFailed: boolean
  operation: 'connecting' | 'cancelling' | 'restarting' | 'disconnecting' | null
  operationFailed: boolean
}
