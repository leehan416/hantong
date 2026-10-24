export type MainDiagnosticType =
  | 'gmail.load.failure'
  | 'gmail.load.timeout'
  | 'gmail.navigation.blocked'
  | 'gmail.process.gone'
  | 'oauth.progress'
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
  | { readonly type: 'gmail.load.failure'; readonly accountId: string; readonly errorCode?: number }
  | { readonly type: 'gmail.load.timeout'; readonly accountId: string }
  | {
      readonly type: 'gmail.navigation.blocked'
      readonly accountId: string
      readonly source: 'redirect' | 'navigation' | 'popup' | 'external_open_failure'
      readonly context: 'main' | 'popup'
      readonly hostname: string
      readonly route: 'google_signin' | 'google_oauth' | 'gmail' | 'other'
      readonly reason: 'external_redirect' | 'oauth_endpoint' | 'unsafe_url' | 'mail_access_denied'
    }
  | {
      readonly type: 'gmail.process.gone'
      readonly accountId: string
      readonly reason: GmailProcessGoneReason
    }
  | {
      readonly type: 'oauth.progress'
      readonly accountId: string
      readonly stage: OAuthDiagnosticStage
      readonly outcome: OAuthDiagnosticOutcome
      readonly code?: OAuthDiagnosticCode
    }
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

export type GmailProcessGoneReason =
  | 'clean-exit'
  | 'abnormal-exit'
  | 'killed'
  | 'crashed'
  | 'oom'
  | 'launch-failed'
  | 'integrity-failure'
  | 'memory-eviction'
  | 'unknown'

export type OAuthDiagnosticStage =
  | 'config'
  | 'connection'
  | 'identity_check'
  | 'authorization'
  | 'token_exchange'
  | 'profile_fetch'
  | 'identity_match'
  | 'persistence'

export type OAuthDiagnosticOutcome = 'started' | 'success' | 'failure' | 'cancelled'

export type OAuthDiagnosticCode =
  | 'cancelled'
  | 'timeout'
  | 'authorization_failed'
  | 'network_error'
  | 'redirect_refused'
  | 'provider_error'
  | 'invalid_response'
  | 'identity_unavailable'
  | 'account_missing'
  | 'identity_mismatch'
  | 'config_unavailable'
  | 'connection_start_failed'
  | 'connection_failed'
  | 'accept_failed'
  | 'missing_view'
  | 'not_ready'
  | 'manager_disposed'
  | 'view_loading'
  | 'view_not_loaded'
  | 'view_blocked'
  | 'view_disposing'
  | 'document_destroyed'
  | 'document_loading'
  | 'untrusted_document'

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
    | 'started'
    | 'cancelled'
    | 'enabled'
    | 'disabled'
    | 'invalid'
    | 'started'
    | 'missing'
    | 'unavailable'
    | 'skipped'
  readonly code?: RelayDiagnosticCode | OAuthDiagnosticCode
  readonly errorCode?: number
  readonly context?: 'main' | 'popup'
  readonly hostname?: string
  readonly route?: 'google_signin' | 'google_oauth' | 'gmail' | 'other'
  readonly reason?:
    | GmailProcessGoneReason
    | 'external_redirect'
    | 'oauth_endpoint'
    | 'unsafe_url'
    | 'mail_access_denied'
  readonly source?: 'redirect' | 'navigation' | 'popup' | 'external_open_failure'
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
