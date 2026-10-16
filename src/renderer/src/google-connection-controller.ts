import type { GoogleConnectionStatus, HantongApi } from '../../shared/ipc'

type GoogleConnectionApi = Pick<
  HantongApi,
  | 'getGoogleConnectionStatus'
  | 'connectGoogleAccount'
  | 'cancelGoogleConnection'
  | 'disconnectGoogleAccount'
>

export interface GoogleConnectionUiState {
  accountId: string | null
  status: GoogleConnectionStatus['status'] | null
  loading: boolean
  readFailed: boolean
  operation: 'connecting' | 'cancelling' | 'disconnecting' | null
  operationFailed: boolean
}

const emptyState: GoogleConnectionUiState = {
  accountId: null,
  status: null,
  loading: false,
  readFailed: false,
  operation: null,
  operationFailed: false
}

export class GoogleConnectionController {
  private state = emptyState
  private revision = 0
  private disposed = false

  constructor(
    private readonly api: GoogleConnectionApi,
    private readonly onChange: (state: GoogleConnectionUiState) => void
  ) {}

  selectAccount(accountId: string | null): void {
    if (this.disposed || accountId === this.state.accountId) return
    this.revision += 1
    this.state = { ...emptyState, accountId }
    this.publish()
    if (accountId) void this.refresh()
  }

  async refresh(): Promise<void> {
    const { accountId } = this.state
    if (this.disposed || !accountId || this.state.operation) return
    const revision = ++this.revision
    this.update({ loading: true, readFailed: false, operationFailed: false })
    try {
      const result = await this.api.getGoogleConnectionStatus(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId || result.status === 'error') {
        this.update({ status: null, loading: false, readFailed: true })
        return
      }
      this.update({ status: result.status, loading: false, readFailed: false })
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.update({ status: null, loading: false, readFailed: true })
    }
  }

  async connect(): Promise<void> {
    const { accountId, status } = this.state
    if (
      this.disposed ||
      !accountId ||
      this.state.operation ||
      (status !== 'disconnected' && status !== 'reconnect_required' && status !== 'error')
    ) {
      return
    }
    const revision = ++this.revision
    this.update({
      status: 'connecting',
      loading: false,
      readFailed: false,
      operation: 'connecting',
      operationFailed: false
    })
    try {
      const result = await this.api.connectGoogleAccount(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId) {
        this.update({ status: null, operation: null, readFailed: true })
      } else {
        this.update({
          status: result.status,
          operation: null,
          loading: false,
          operationFailed: result.status === 'error'
        })
      }
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.update({ status: 'error', operation: null, operationFailed: true })
    }
  }

  async cancel(): Promise<void> {
    const { accountId, status, operation } = this.state
    if (this.disposed || !accountId || status !== 'connecting' || operation === 'cancelling') {
      return
    }
    const revision = ++this.revision
    this.update({
      loading: false,
      readFailed: false,
      operation: 'cancelling',
      operationFailed: false
    })
    try {
      const result = await this.api.cancelGoogleConnection(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId || result.status === 'error') {
        this.update({ status: null, operation: null, readFailed: true })
      } else {
        this.update({ status: result.status, operation: null, loading: false })
      }
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.update({ status: null, operation: null, loading: false, readFailed: true })
    }
  }

  async disconnect(): Promise<void> {
    const { accountId, status } = this.state
    if (this.disposed || !accountId || status !== 'connected' || this.state.operation) return
    const revision = ++this.revision
    this.update({
      loading: false,
      readFailed: false,
      operation: 'disconnecting',
      operationFailed: false
    })
    try {
      const result = await this.api.disconnectGoogleAccount(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId || result.status === 'error') {
        this.update({ status: null, operation: null, readFailed: true })
      } else {
        this.update({ status: result.status, operation: null, loading: false })
      }
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.update({ status: null, operation: null, loading: false, readFailed: true })
    }
  }

  dispose(): void {
    this.disposed = true
    this.revision += 1
  }

  private isCurrent(revision: number, accountId: string): boolean {
    return !this.disposed && this.revision === revision && this.state.accountId === accountId
  }

  private update(changes: Partial<GoogleConnectionUiState>): void {
    this.state = { ...this.state, ...changes }
    this.publish()
  }

  private publish(): void {
    if (!this.disposed) this.onChange(this.state)
  }
}
