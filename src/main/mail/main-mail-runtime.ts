import { app, powerMonitor, safeStorage, shell, type BrowserWindow, type Tray } from 'electron'
import { join } from 'node:path'
import { createGoogleCredentialStore } from '~/main/google/google-credential-store'
import { createGoogleConnectionManager } from '~/main/google/google-connection-manager'
import { createGoogleConnectionRuntime } from '~/main/google/google-connection-runtime'
import { loadRuntimeGoogleOAuthConfig } from '~/main/google/google-oauth-runtime-config'
import { loadRuntimeRelayConfig } from '~/main/relay/relay-config'
import { createRelayClient } from '~/main/relay/relay-client'
import { createRelayRuntime } from '~/main/relay/relay-runtime'
import { createRelayCredentialStore } from '~/main/relay/relay-credential-store'
import { createGmailSyncStore } from '~/main/gmail/gmail-sync-store'
import { createGmailHistorySync } from '~/main/gmail/gmail-history-sync'
import { createGmailWatchManager } from '~/main/gmail/gmail-watch-manager'
import { createGmailRelaySync } from '~/main/gmail/gmail-relay-sync'
import { createGmailMailAlerts } from '~/main/gmail/gmail-mail-alerts'
import { createNotificationConnectionController } from '~/main/notifications/notification-connection-controller'
import { createMainMailDiagnostics } from './main-mail-diagnostics'
import { createRelayChallengePreparation } from '~/main/relay/main-relay-challenge'
import { updateTrayUnreadCount } from '~/main/notifications/tray-unread-count'
import {
  fetchGmailHistoryId,
  fetchGmailHistoryPage,
  fetchGmailMessageSummary,
  fetchGmailUnreadCount,
  registerGmailWatch
} from '~/main/gmail/gmail-metadata'
import { startGoogleAuthorization } from '~/main/google/google-authorization'
import {
  exchangeGoogleAuthorizationCode,
  fetchGoogleProfileEmail,
  refreshGoogleAccessToken
} from '~/main/google/google-token-exchange'
import { createMainDiagnostics } from '~/main/diagnostics/main-diagnostics'
import type { createAccountStore } from '~/main/accounts/account-store'
import type { createAccountAccessController } from '~/main/accounts/account-access-controller'
import type { createAccountRemovalController } from '~/main/accounts/account-removal'
import type { createNotificationRecoveryRuntime } from '~/main/notifications/notification-recovery-runtime'
import type { GmailMailAlert } from '~/main/gmail/gmail-mail-alerts'
import type { NotificationPauseSnapshot } from '~/main/notifications/notification-pause'
import { UNREAD_COUNTS_EVENT, NOTIFICATION_CONNECTIONS_EVENT } from '~/shared/ipc'

type AccountStore = ReturnType<typeof createAccountStore>
type MailAlerts = ReturnType<typeof createGmailMailAlerts>
type RelayRuntime = ReturnType<typeof createRelayRuntime>
type GmailRelaySync = ReturnType<typeof createGmailRelaySync>
type GoogleConnectionRuntime = ReturnType<typeof createGoogleConnectionRuntime>
type NotificationController = ReturnType<typeof createNotificationConnectionController>
type Diagnostics = ReturnType<typeof createMainDiagnostics>

export interface MainMailRuntimeDependencies {
  readonly diagnostics: Diagnostics
  readonly requireAccountStore: () => AccountStore
  readonly window: () => BrowserWindow | null
  readonly views: () => {
    readWebIdentity: (
      id: string,
      signal?: AbortSignal
    ) => Promise<{ accountExists: boolean; emailAddress: string | null }>
  } | null
  readonly accessController: () => ReturnType<typeof createAccountAccessController> | null
  readonly accountRemoval: () => ReturnType<typeof createAccountRemovalController> | null
  readonly tray: () => Tray | null
  readonly isQuitting: () => boolean
  readonly recovery: ReturnType<typeof createNotificationRecoveryRuntime>
  readonly locale: () => 'ko' | 'en'
  readonly notify: (alert: GmailMailAlert) => void
  readonly notificationPause: () => NotificationPauseSnapshot
  readonly refreshNotificationPause: () => void
  readonly bundledEnvironment: Record<string, string | undefined>
  readonly revealForAuthorization: () => void
}

export function createMainMailRuntime(dependencies: MainMailRuntimeDependencies): {
  connectionManager: ReturnType<typeof createGoogleConnectionManager>
  relayRuntime: RelayRuntime
  gmailRelaySync: GmailRelaySync
  googleConnectionRuntime: GoogleConnectionRuntime
  notificationConnectionController: NotificationController
  mailAlerts: MailAlerts
  fallbackSync: ReturnType<typeof setInterval>
} {
  let relayRuntime: RelayRuntime | null = null
  let gmailRelaySync: GmailRelaySync | null = null
  let googleConnectionRuntime: GoogleConnectionRuntime | null = null
  let notificationConnectionController: NotificationController | null = null
  let mailAlerts: MailAlerts | null = null
  const { diagnostics } = dependencies
  const mailDiagnostics = createMainMailDiagnostics({
    diagnostics,
    notifications: () => notificationConnectionController
  })

  const credentialStore = createGoogleCredentialStore({
    directory: join(app.getPath('userData'), 'google-credentials'),
    platform: process.platform,
    safeStorage
  })
  const connectionManager = createGoogleConnectionManager({
    credentialStore,
    now: () => Date.now(),
    refreshTokens: (config, refreshToken, signal) =>
      refreshGoogleAccessToken(config, refreshToken, {
        fetch,
        signal,
        now: () => Date.now()
      })
  })
  let relayClient: ReturnType<typeof createRelayClient> | undefined
  const relayConfig = (): ReturnType<typeof loadRuntimeRelayConfig> =>
    loadRuntimeRelayConfig({
      environment: process.env,
      isPackaged: app.isPackaged,
      localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
      bundled: dependencies.bundledEnvironment
    })
  const accountExists = (id: string): boolean =>
    dependencies
      .requireAccountStore()
      .getState()
      .accounts.some((account) => account.id === id)
  const resolveRelayClient = (): ReturnType<typeof createRelayClient> | undefined => {
    if (relayClient) return relayClient
    const config = relayConfig()
    if (!config) return undefined
    relayClient = createRelayClient({ baseUrl: config.baseUrl, fetch, now: () => Date.now() })
    return relayClient
  }
  const prepareRelayChallenge = createRelayChallengePreparation({
    diagnostics,
    accountExists,
    resolveClient: resolveRelayClient,
    isPackaged: app.isPackaged
  })
  const gmailAccessToken = (accountId: string): Promise<string> =>
    connectionManager.getAccessToken(
      accountId,
      loadRuntimeGoogleOAuthConfig({
        environment: process.env,
        isPackaged: app.isPackaged,
        localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
        bundled: dependencies.bundledEnvironment
      })
    )
  let gmailTopic: string | undefined
  try {
    gmailTopic = relayConfig()?.gmailTopic
  } catch {
    // Invalid relay settings already disable the relay session; a watch is useless without it.
    gmailTopic = undefined
  }
  const historySync = createGmailHistorySync({
    store: createGmailSyncStore(app.getPath('userData')),
    accountExists,
    readHistoryId: async (accountId, signal) =>
      fetchGmailHistoryId(await gmailAccessToken(accountId), { fetch, signal }),
    readHistoryPage: async (accountId, startHistoryId, pageToken, signal) =>
      fetchGmailHistoryPage(await gmailAccessToken(accountId), startHistoryId, pageToken, {
        fetch,
        signal
      })
  })
  const korean = (): boolean => dependencies.locale() === 'ko'
  mailAlerts = createGmailMailAlerts({
    notificationPause: dependencies.notificationPause,
    accountExists,
    notificationsEnabled: (id) =>
      dependencies
        .requireAccountStore()
        .getState()
        .accounts.find((account) => account.id === id)?.notificationsEnabled !== false,
    korean,
    readUnreadCount: async (accountId) =>
      fetchGmailUnreadCount(await gmailAccessToken(accountId), 'INBOX', {
        fetch,
        signal: AbortSignal.timeout(30_000)
      }),
    readSummary: async (accountId, messageId) =>
      fetchGmailMessageSummary(await gmailAccessToken(accountId), messageId, {
        fetch,
        signal: AbortSignal.timeout(30_000)
      }),
    notify: dependencies.notify,
    onDiagnostic: mailDiagnostics.onUnread,
    setBadge: (total) => {
      app.setBadgeCount(total)
      updateTrayUnreadCount(total, process.platform, (title) =>
        dependencies.tray()?.setTitle(title)
      )
      const window = dependencies.window()
      if (window && !window.isDestroyed()) {
        window.webContents.send(
          UNREAD_COUNTS_EVENT,
          Object.fromEntries(mailAlerts?.unreadCounts() ?? new Map())
        )
      }
    }
  })
  const topic = gmailTopic
  gmailRelaySync = createGmailRelaySync({
    sync: (accountId) => historySync.sync(accountId),
    resetSync: (accountId) => historySync.reset(accountId),
    watch: topic
      ? createGmailWatchManager({
          accountExists,
          registerWatch: async (accountId, signal) =>
            registerGmailWatch(await gmailAccessToken(accountId), topic, {
              fetch,
              signal,
              now: () => Date.now()
            }),
          onDiagnostic: mailDiagnostics.onWatch
        })
      : undefined,
    now: () => Date.now(),
    onChanges: (accountId, result) => {
      void mailAlerts?.onChanges(accountId, result).catch(() => undefined)
    },
    onDiagnostic: mailDiagnostics.onHistory
  })
  const allAccountIds = (): string[] =>
    dependencies
      .requireAccountStore()
      .getState()
      .accounts.map((account) => account.id)
  powerMonitor.on('suspend', () => {
    gmailRelaySync?.suspend()
    notificationConnectionController?.suspend()
  })
  powerMonitor.on('resume', () => {
    gmailRelaySync?.resume(allAccountIds())
    notificationConnectionController?.resume(allAccountIds())
    dependencies.refreshNotificationPause()
  })
  // ponytail: fixed 15-minute fallback poll; derive from relay health if quota or latency matters.
  const fallbackSync = setInterval(() => gmailRelaySync?.syncAll(allAccountIds()), 15 * 60_000)
  // Catch up on mail that arrived while the app was closed; never-connected accounts just fail.
  gmailRelaySync.syncAll(allAccountIds())
  relayRuntime = createRelayRuntime({
    client: {
      createSession: (...args) => {
        const client = relayClient ?? resolveRelayClient()
        if (!client) return Promise.reject(new Error('Relay is disabled'))
        return client.createSession(...args)
      },
      refreshSession: (...args) => {
        const client = relayClient ?? resolveRelayClient()
        if (!client) return Promise.reject(new Error('Relay is disabled'))
        return client.refreshSession(...args)
      },
      consumeEvents: (...args) =>
        relayClient?.consumeEvents(...args) ?? Promise.reject(new Error('Relay is disabled')),
      deleteSession: (token) => relayClient?.deleteSession(token) ?? Promise.resolve()
    },
    accountExists,
    now: () => Date.now(),
    credentials: createRelayCredentialStore({
      directory: join(app.getPath('userData'), 'relay-credentials'),
      platform: process.platform,
      safeStorage
    }),
    onSignal: (accountId, event) => gmailRelaySync?.onSignal(accountId, event),
    onDiagnostic: mailDiagnostics.onRelay
  })
  let relayEnabled: boolean
  let relayMode: 'enabled' | 'disabled' | 'invalid'
  try {
    relayEnabled = relayConfig() !== undefined
    relayMode = relayEnabled ? 'enabled' : 'disabled'
    diagnostics.record({
      type: 'relay.bootstrap',
      stage: 'config',
      outcome: relayEnabled ? 'enabled' : 'disabled'
    })
  } catch {
    relayEnabled = false
    relayMode = 'invalid'
    // Invalid relay settings leave the relay off; Gmail still syncs through the fallback poll.
    diagnostics.record({
      type: 'relay.bootstrap',
      stage: 'config',
      outcome: 'invalid',
      code: 'invalid_response'
    })
  }
  // Reattach saved relay sessions without a browser round-trip; unknown accounts are skipped.
  if (relayEnabled) {
    for (const accountId of allAccountIds()) void relayRuntime.resume(accountId)
  }
  googleConnectionRuntime = createGoogleConnectionRuntime({
    accountExists,
    readWebIdentity: (id, signal) =>
      dependencies.views()?.readWebIdentity(id, signal) ?? Promise.resolve(null),
    loadConfig: () =>
      loadRuntimeGoogleOAuthConfig({
        environment: process.env,
        isPackaged: app.isPackaged,
        localEnvPath: app.isPackaged ? undefined : join(app.getAppPath(), '.env'),
        bundled: dependencies.bundledEnvironment
      }),
    prepareRelayChallenge,
    startAuthorization: (config, nonce) =>
      startGoogleAuthorization(config, {
        openExternal: (url) => shell.openExternal(url),
        nonce
      }),
    exchangeCode: (config, authorization, signal) =>
      exchangeGoogleAuthorizationCode(config, authorization, {
        fetch,
        signal,
        now: () => Date.now()
      }),
    fetchProfile: (accessToken, signal) => fetchGoogleProfileEmail(accessToken, { fetch, signal }),
    manager: connectionManager,
    onConnected: (accountId, result) => {
      notificationConnectionController?.event({ type: 'google', accountId, outcome: 'connected' })
      relayRuntime?.accept(accountId, {
        idToken: result.tokens.idToken,
        nonce: result.relayNonce
      })
    },
    onAuthorizationReceived: () => {
      dependencies.revealForAuthorization()
    },
    onDisconnected: (accountId) => {
      notificationConnectionController?.event({
        type: 'google',
        accountId,
        outcome: 'disconnected'
      })
      relayRuntime?.disconnect(accountId)
      gmailRelaySync?.disconnect(accountId)
      diagnostics.forget(accountId)
      mailAlerts?.remove(accountId)
    },
    onPendingChanged: () => notificationConnectionController?.flushAlerts(),
    reportProgress: (accountId, stage, outcome, code) => {
      diagnostics.record({
        type: 'oauth.progress',
        accountId,
        stage,
        outcome,
        ...(code ? { code } : {})
      })
    }
  })
  notificationConnectionController = createNotificationConnectionController({
    accountExists,
    googleStatus: async (id) => {
      try {
        const status = await connectionManager.getStatus(id)
        return status.status
      } catch {
        return 'unavailable'
      }
    },
    syncNow: (id) => gmailRelaySync?.syncAll([id]),
    recover: async (id) => dependencies.recovery.request(id),
    cancelRecovery: async (id) => {
      await dependencies.recovery.clearPending(id)
    },
    reconnectRelay: async (id) => {
      await relayRuntime?.reconnect(id)
      gmailRelaySync?.retryWatch(id)
    },
    canAlert: (id) => {
      const window = dependencies.window()
      return Boolean(
        window &&
        !window.isDestroyed() &&
        window.isVisible() &&
        !dependencies.isQuitting() &&
        !dependencies.recovery.isDialogActive() &&
        !dependencies.accountRemoval()?.isBusy() &&
        !dependencies.recovery.hasPending() &&
        !googleConnectionRuntime?.hasPendingConnections() &&
        dependencies.accessController()?.getState(id).connectionStatus !== 'connecting'
      )
    },
    alert: (id, status) => dependencies.recovery.showDialog(id, status),
    publish: (states) => {
      const window = dependencies.window()
      if (window && !window.isDestroyed())
        window.webContents.send(NOTIFICATION_CONNECTIONS_EVENT, states)
    },
    now: () => Date.now()
  })
  notificationConnectionController.configure({
    relay: relayMode,
    watchConfigured: Boolean(topic),
    accountIds: allAccountIds()
  })

  if (
    !relayRuntime ||
    !gmailRelaySync ||
    !googleConnectionRuntime ||
    !notificationConnectionController ||
    !mailAlerts ||
    !fallbackSync
  ) {
    throw new Error('Main mail runtime is incomplete')
  }
  return {
    connectionManager,
    relayRuntime,
    gmailRelaySync,
    googleConnectionRuntime,
    notificationConnectionController,
    mailAlerts,
    fallbackSync
  }
}
