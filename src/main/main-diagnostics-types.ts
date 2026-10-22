export type MainDiagnosticType =
  | 'relay.ready'
  | 'relay.receive'
  | 'relay.heartbeat'
  | 'relay.closed'
  | 'relay.failure'
  | 'relay.retry'
  | 'relay.session'
  | 'relay.refresh'
  | 'relay.bootstrap'
  | 'sync.success'
  | 'sync.null'
  | 'sync.failure'
  | 'watch.renewed'
  | 'watch.retry'
  | 'watch.blocked'
  | 'watch.cancelled'
  | 'unread.success'
  | 'unread.failure'
  | 'unread.applied'
  | 'unread.stale'

export type MainDiagnosticEvent =
  | { readonly type: 'relay.ready'; readonly accountId: string }
  | { readonly type: 'relay.receive'; readonly accountId: string }
  | { readonly type: 'relay.heartbeat'; readonly accountId: string }
  | { readonly type: 'relay.closed'; readonly accountId: string }
  | {
      readonly type: 'relay.failure'
      readonly accountId: string
      readonly code: RelayDiagnosticCode
    }
  | {
      readonly type: 'relay.retry'
      readonly accountId: string
      readonly code: RelayDiagnosticCode
      readonly delayMs: number
    }
  | {
      readonly type: 'relay.session' | 'relay.refresh'
      readonly accountId: string
      readonly outcome: 'success' | 'failure' | 'retry' | 'blocked'
      readonly code?: RelayDiagnosticCode
    }
  | {
      readonly type: 'relay.bootstrap'
      readonly accountId?: string
      readonly stage:
        | 'config'
        | 'challenge'
        | 'proof'
        | 'proof_id_token'
        | 'proof_nonce'
        | 'credentials'
        | 'session_start'
        | 'stream_start'
        | 'credential_write'
      readonly outcome:
        | 'enabled'
        | 'disabled'
        | 'invalid'
        | 'started'
        | 'missing'
        | 'unavailable'
        | 'success'
        | 'failure'
        | 'skipped'
      readonly code?: RelayDiagnosticCode
    }
  | {
      readonly type: 'sync.success'
      readonly accountId: string
      readonly kind: 'baseline' | 'changes'
    }
  | { readonly type: 'sync.null' | 'sync.failure'; readonly accountId: string }
  | {
      readonly type: 'watch.renewed'
      readonly accountId: string
      readonly expiresAt: number
    }
  | {
      readonly type: 'watch.retry' | 'watch.blocked' | 'watch.cancelled'
      readonly accountId: string
      readonly nextAttemptAt: number | null
    }
  | { readonly type: 'unread.success'; readonly accountId: string }
  | { readonly type: 'unread.failure'; readonly accountId: string }
  | { readonly type: 'unread.applied'; readonly accountId: string; readonly count: number }
  | { readonly type: 'unread.stale'; readonly accountId: string }

export type RelayDiagnosticCode =
  | 'cancelled'
  | 'timeout'
  | 'network_error'
  | 'unauthorized'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response'
  | 'redirect_refused'
  | 'unknown'

export interface MainDiagnosticSink {
  append(line: string): void | Promise<void>
  flush(): Promise<void>
}

export interface MainDiagnosticsOptions {
  readonly now: () => number
  readonly sink?: MainDiagnosticSink
  readonly observe?: (event: MainDiagnosticEvent) => void
  readonly maxEvents?: number
  readonly maxAccounts?: number
  readonly heartbeatThrottleMs?: number
  readonly receiveThrottleMs?: number
}

export interface MainDiagnosticRecord {
  readonly at: number
  readonly type: MainDiagnosticType
  readonly account?: string
  readonly outcome?:
    | 'success'
    | 'failure'
    | 'retry'
    | 'blocked'
    | 'enabled'
    | 'disabled'
    | 'invalid'
    | 'started'
    | 'missing'
    | 'unavailable'
    | 'skipped'
  readonly code?: RelayDiagnosticCode
  readonly kind?: 'baseline' | 'changes'
  readonly expiresAt?: number
  readonly nextAttemptAt?: number | null
  readonly count?: number
  readonly stage?: string
}

export type AccountSnapshot = {
  relay?: {
    readyAt?: number
    closedAt?: number
    lastReceiveAt?: number
    heartbeatAt?: number
    lastFailure?: RelayDiagnosticCode
  }
  sync?: {
    at: number
    outcome: 'success' | 'null' | 'failure'
    lastSuccessAt?: number
    kind?: 'baseline' | 'changes'
  }
  watch?: {
    at: number
    outcome: 'renewed' | 'retry' | 'blocked' | 'cancelled'
    expiresAt?: number
    lastSuccessAt?: number
    nextAttemptAt?: number | null
  }
  unread?: {
    at: number
    outcome: 'success' | 'failure' | 'applied' | 'stale'
    lastSuccessAt?: number
    lastAppliedAt?: number
    count?: number
  }
  session?: {
    at: number
    outcome: 'success' | 'failure' | 'retry' | 'blocked'
    lastSuccessAt?: number
    code?: RelayDiagnosticCode
  }
  refresh?: {
    at: number
    outcome: 'success' | 'failure' | 'retry' | 'blocked'
    lastSuccessAt?: number
    code?: RelayDiagnosticCode
  }
  bootstrap?: {
    at: number
    stage: string
    outcome: NonNullable<MainDiagnosticRecord['outcome']>
    code?: RelayDiagnosticCode
  }
}

export interface MainDiagnosticsSnapshot {
  readonly events: readonly MainDiagnosticRecord[]
  readonly accounts: Readonly<Record<string, Readonly<AccountSnapshot>>>
}
