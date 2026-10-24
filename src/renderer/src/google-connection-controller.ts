import type { AccountAccessState, GoogleConnectionStatus, HantongApi } from '../../shared/ipc'

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
  operation: 'connecting' | 'cancelling' | 'restarting' | 'disconnecting' | null
  operationFailed: boolean
}

export function hasPendingGoogleConnection(states: readonly GoogleConnectionUiState[]): boolean {
  return states.some((state) => state.operation !== null || state.status === 'connecting')
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
  private restartInProgress = false

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

  applyExternalStatus(status: GoogleConnectionStatus): void {
    if (this.disposed || status.accountId !== this.state.accountId) return
    if (this.state.operation) {
      this.update({ status: status.status, loading: false, readFailed: false })
      return
    }
    this.revision += 1
    this.update({
      status: status.status,
      loading: false,
      readFailed: false,
      operationFailed: false
    })
  }

  async connect(allowExistingConnection = false): Promise<void> {
    const { accountId, status } = this.state
    if (
      this.disposed ||
      !accountId ||
      this.state.operation ||
      (status !== 'disconnected' &&
        status !== 'reconnect_required' &&
        status !== 'error' &&
        !(allowExistingConnection && status === 'connected'))
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
    if (
      this.disposed ||
      !accountId ||
      status !== 'connecting' ||
      (operation !== null && operation !== 'connecting')
    ) {
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

  async restart(isStillCurrent: () => boolean): Promise<void> {
    const { accountId, status, operation } = this.state
    if (
      this.disposed ||
      this.restartInProgress ||
      !accountId ||
      status !== 'connecting' ||
      (operation !== null && operation !== 'connecting')
    )
      return

    this.restartInProgress = true
    let unlockRestart = true
    const revision = ++this.revision
    this.update({
      loading: false,
      readFailed: false,
      operation: 'restarting',
      operationFailed: false
    })
    try {
      const result = await this.api.cancelGoogleConnection(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId || result.status === 'error') {
        this.update({ status: null, operation: null, loading: false, readFailed: true })
        return
      }
      if (!isStillCurrent()) {
        this.update({ status: result.status, operation: null, loading: false })
        return
      }
      if (result.status === 'connecting') {
        this.update({ status: null, operation: null, loading: false, readFailed: true })
        return
      }
      this.update({ status: result.status, operation: null, loading: false })
      this.restartInProgress = false
      unlockRestart = false
      await this.connect(true)
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.update({ status: null, operation: null, loading: false, readFailed: true })
    } finally {
      if (unlockRestart) this.restartInProgress = false
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

export class GoogleConnectionControllerPool {
  private readonly controllers = new Map<string, GoogleConnectionController>()

  constructor(
    private readonly api: GoogleConnectionApi,
    private readonly onChange: (state: GoogleConnectionUiState) => void
  ) {}

  forAccount(accountId: string): GoogleConnectionController {
    const existing = this.controllers.get(accountId)
    if (existing) return existing

    const controller = new GoogleConnectionController(this.api, this.onChange)
    this.controllers.set(accountId, controller)
    controller.selectAccount(accountId)
    return controller
  }

  applyExternalStatus(status: GoogleConnectionStatus): void {
    this.controllers.get(status.accountId)?.applyExternalStatus(status)
  }

  remove(accountId: string): void {
    this.controllers.get(accountId)?.dispose()
    this.controllers.delete(accountId)
  }

  dispose(): void {
    for (const controller of this.controllers.values()) controller.dispose()
    this.controllers.clear()
  }
}

type AccountAccessApi = Pick<HantongApi, 'getAccountAccessState' | 'onAccountAccessState'>

export interface AccountAccessUiState {
  accountId: string | null
  state: AccountAccessState | null
  loading: boolean
  readFailed: boolean
}

const emptyAccessState: AccountAccessUiState = {
  accountId: null,
  state: null,
  loading: false,
  readFailed: false
}

export class AccountAccessController {
  private state = emptyAccessState
  private revision = 0
  private disposed = false
  private unsubscribe: () => void = () => {}
  private subscriptionFailed = false

  constructor(
    private readonly api: AccountAccessApi,
    private readonly onChange: (state: AccountAccessUiState) => void,
    private readonly onConnectionStatus: (state: AccountAccessState) => void
  ) {
    try {
      this.unsubscribe = api.onAccountAccessState((state) => {
        if (this.disposed) return
        // Main releases a previous account's OAuth after the selection moved; its connection status
        // must still update, or that stale "connecting" state keeps account switching locked.
        this.onConnectionStatus(state)
        if (state.accountId !== this.state.accountId) return
        this.revision += 1
        this.state = { accountId: state.accountId, state, loading: false, readFailed: false }
        this.publish()
      })
    } catch {
      this.subscriptionFailed = true
    }
  }

  selectAccount(accountId: string | null): void {
    if (this.disposed || accountId === this.state.accountId) return
    this.revision += 1
    this.state = {
      accountId,
      state: null,
      loading: Boolean(accountId),
      readFailed: this.subscriptionFailed
    }
    this.publish()
    if (accountId) void this.refresh()
  }

  async refresh(): Promise<void> {
    const { accountId } = this.state
    if (this.disposed || !accountId) return
    const revision = ++this.revision
    this.state = { ...this.state, loading: true, readFailed: this.subscriptionFailed }
    this.publish()
    try {
      const result = await this.api.getAccountAccessState(accountId)
      if (!this.isCurrent(revision, accountId)) return
      if (result.accountId !== accountId) {
        this.state = { ...this.state, state: null, loading: false, readFailed: true }
      } else {
        this.state = { accountId, state: result, loading: false, readFailed: false }
        this.onConnectionStatus(result)
      }
    } catch {
      if (!this.isCurrent(revision, accountId)) return
      this.state = { ...this.state, state: null, loading: false, readFailed: true }
    }
    this.publish()
  }

  dispose(): void {
    this.disposed = true
    this.revision += 1
    this.unsubscribe()
  }

  private isCurrent(revision: number, accountId: string): boolean {
    return !this.disposed && this.revision === revision && this.state.accountId === accountId
  }

  private publish(): void {
    if (!this.disposed) this.onChange(this.state)
  }
}
