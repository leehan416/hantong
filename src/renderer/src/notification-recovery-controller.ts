import type {
  HantongApi,
  NotificationConnectionState,
  NotificationConnectionStates
} from '../../shared/ipc'

type NotificationRecoveryApi = Pick<
  HantongApi,
  | 'getNotificationConnections'
  | 'onNotificationConnections'
  | 'recoverNotifications'
  | 'cancelNotificationRecovery'
  | 'retryNotifications'
>

export interface NotificationRecoveryUiState {
  accountId: string | null
  notification: NotificationConnectionState | null
  operation: 'recovering' | 'cancelling' | 'retrying' | null
  operationFailed: boolean
}

const emptyState: NotificationRecoveryUiState = {
  accountId: null,
  notification: null,
  operation: null,
  operationFailed: false
}

export class NotificationRecoveryController {
  private states: NotificationConnectionStates = {}
  private accountId: string | null = null
  private revision = 0
  private snapshotRevision = 0
  private disposed = false
  private operations = new Map<string, NotificationRecoveryUiState['operation']>()
  private operationTokens = new Map<string, symbol>()
  private operationFailed = new Set<string>()
  private accountGenerations = new Map<string, number>()
  private healthRevisions = new Map<string, number>()
  private unsubscribe: () => void = () => {}

  constructor(
    private readonly api: NotificationRecoveryApi,
    private readonly onChange: (state: NotificationRecoveryUiState) => void
  ) {
    try {
      this.unsubscribe = api.onNotificationConnections((states) => {
        if (this.disposed) return
        this.snapshotRevision += 1
        this.states = this.validateStates(states)
        for (const [accountId, state] of Object.entries(this.states)) {
          if (state.status === 'connected' || state.status === 'disabled') {
            this.operationFailed.delete(accountId)
            this.healthRevisions.set(accountId, (this.healthRevisions.get(accountId) ?? 0) + 1)
          }
        }
        this.publish()
      })
    } catch {
      // A status subscription failure must not prevent explicit retries from working.
    }

    void Promise.resolve()
      .then(() => api.getNotificationConnections())
      .then(
        (states) => {
          if (this.disposed || this.snapshotRevision !== 0) return
          this.states = this.validateStates(states)
          this.publish()
        },
        () => {
          // The next Main event or explicit action can still recover status visibility.
        }
      )
  }

  selectAccount(accountId: string | null): void {
    if (this.disposed || accountId === this.accountId) return
    this.accountId = accountId
    this.revision += 1
    this.publish()
  }

  async recover(): Promise<void> {
    await this.runAction('recovering', 'recoverNotifications')
  }

  async cancel(): Promise<void> {
    await this.runAction('cancelling', 'cancelNotificationRecovery')
  }

  async retry(): Promise<void> {
    await this.runAction('retrying', 'retryNotifications')
  }

  removeAccount(accountId: string): void {
    if (this.disposed) return
    const next = { ...this.states }
    delete next[accountId]
    this.states = next
    this.operations.delete(accountId)
    this.operationTokens.delete(accountId)
    this.operationFailed.delete(accountId)
    this.accountGenerations.set(accountId, (this.accountGenerations.get(accountId) ?? 0) + 1)
    if (this.accountId === accountId) {
      this.accountId = null
      this.revision += 1
    }
    this.publish()
  }

  dispose(): void {
    this.disposed = true
    this.revision += 1
    this.unsubscribe()
    this.operations.clear()
    this.operationTokens.clear()
  }

  private async runAction(
    operation: Exclude<NotificationRecoveryUiState['operation'], null>,
    method: 'recoverNotifications' | 'cancelNotificationRecovery' | 'retryNotifications'
  ): Promise<void> {
    const accountId = this.accountId
    if (this.disposed || !accountId) return

    const revision = this.revision
    const generation = this.accountGenerations.get(accountId) ?? 0
    const healthRevision = this.healthRevisions.get(accountId) ?? 0
    const currentOperation = this.operations.get(accountId)
    if (currentOperation && !(operation === 'cancelling' && currentOperation === 'recovering')) {
      return
    }
    const operationToken = Symbol(accountId)
    this.operations.set(accountId, operation)
    this.operationTokens.set(accountId, operationToken)
    this.operationFailed.delete(accountId)
    this.publish()

    let failed = false
    try {
      await this.api[method](accountId)
    } catch {
      failed = true
    }

    if (this.operationTokens.get(accountId) !== operationToken) return
    this.operations.delete(accountId)
    this.operationTokens.delete(accountId)
    const accountRemoved = (this.accountGenerations.get(accountId) ?? 0) !== generation
    if (this.disposed || accountRemoved) return
    if (
      failed &&
      this.accountId === accountId &&
      this.revision === revision &&
      (this.healthRevisions.get(accountId) ?? 0) === healthRevision
    ) {
      this.operationFailed.add(accountId)
    }
    if (this.accountId === accountId) this.publish()
  }

  private validateStates(states: NotificationConnectionStates): NotificationConnectionStates {
    const valid: NotificationConnectionStates = {}
    for (const [accountId, state] of Object.entries(states)) {
      if (state.accountId === accountId) valid[accountId] = state
    }
    return valid
  }

  private publish(): void {
    if (this.disposed) return
    const accountId = this.accountId
    this.onChange(
      accountId
        ? {
            accountId,
            notification: this.states[accountId] ?? null,
            operation: this.operations.get(accountId) ?? null,
            operationFailed: this.operationFailed.has(accountId)
          }
        : emptyState
    )
  }
}
