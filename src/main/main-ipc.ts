import { app, dialog, ipcMain, nativeTheme, webContents, type BrowserWindow } from 'electron'
import { isAccountColor, type AccountState } from '../shared/accounts'
import type { AppSettingsPatch } from '../shared/settings'
import type { AiMailComposeDiagnostic, AppInfo } from '../shared/ipc'
import type { createAccountStore } from './account-store'
import type { createAccountRemovalController } from './account-removal'
import type { createAccountViewManager } from './account-view-manager'
import type { createSettingsStore } from './settings-store'
import type { createAccountAccessController } from './account-access-controller'
import type { createGoogleConnectionRuntime } from './google-connection-runtime'
import type { createNotificationConnectionController } from './notification-connection-controller'
import type { createGmailCleanupRuntime } from './gmail-cleanup-runtime'
import type { createNotificationRecoveryRuntime } from './notification-recovery-runtime'
import {
  ACCOUNT_ACTIVATE_CHANNEL,
  ACCOUNT_ADD_CHANNEL,
  ACCOUNT_MOVE_CHANNEL,
  ACCOUNT_DISPLAY_NAME_CHANNEL,
  ACCOUNT_COLOR_CHANNEL,
  ACCOUNT_NOTIFICATIONS_ENABLED_CHANNEL,
  ACCOUNT_RETRY_CHANNEL,
  ACCOUNT_REMOVE_CHANNEL,
  ACCOUNT_STATE_CHANNEL,
  ACCOUNT_STATUS_STRIP_CHANNEL,
  AI_MAIL_PANEL_LAYOUT_CHANNEL,
  UNREAD_COUNTS_CHANNEL,
  SETTINGS_GET_CHANNEL,
  SETTINGS_UPDATE_CHANNEL,
  SETTINGS_EVENT,
  SETTINGS_PANEL_CHANNEL,
  ACCOUNT_VIEW_STATUS_EVENT,
  APP_INFO_CHANNEL,
  GOOGLE_CONNECTION_CANCEL_CHANNEL,
  GOOGLE_CONNECTION_CONNECT_CHANNEL,
  GOOGLE_CONNECTION_DISCONNECT_CHANNEL,
  GOOGLE_CONNECTION_STATUS_CHANNEL,
  NOTIFICATION_CONNECTIONS_CHANNEL,
  NOTIFICATION_RECOVER_CHANNEL,
  NOTIFICATION_RECOVERY_CANCEL_CHANNEL,
  NOTIFICATION_RETRY_CHANNEL,
  ACCOUNT_ACCESS_STATE_CHANNEL,
  LOGIN_LAUNCH_GET_CHANNEL,
  LOGIN_LAUNCH_SET_CHANNEL,
  AI_MAIL_CODEX_STATUS_CHANNEL,
  AI_MAIL_CODEX_CONNECT_CHANNEL,
  AI_MAIL_CODEX_DISCONNECT_CHANNEL,
  AI_MAIL_CODEX_GENERATE_CHANNEL,
  AI_MAIL_CODEX_CANCEL_CHANNEL,
  AI_MAIL_OLLAMA_GENERATE_CHANNEL,
  AI_MAIL_OLLAMA_CANCEL_CHANNEL,
  OLLAMA_STATUS_CHANNEL,
  OLLAMA_MODELS_CHANNEL,
  CODEX_MODELS_CHANNEL,
  CLIPBOARD_WRITE_TEXT_CHANNEL,
  OLLAMA_CREDENTIAL_STATUS_CHANNEL,
  OLLAMA_CREDENTIAL_SET_CHANNEL,
  OLLAMA_CREDENTIAL_CLEAR_CHANNEL,
  AI_MAIL_COMPOSE_TARGET_STATUS_CHANNEL,
  AI_MAIL_COMPOSE_SNAPSHOT_CHANNEL,
  AI_MAIL_COMPOSE_SELECT_TARGET_CHANNEL,
  AI_MAIL_COMPOSE_APPLY_CHANNEL,
  AI_MAIL_COMPOSE_UNDO_CHANNEL,
  AI_MAIL_READ_SNAPSHOT_CHANNEL,
  AI_MAIL_READ_SNAPSHOT_CURRENT_CHANNEL,
  AI_MAIL_SUBJECT_APPLY_CHANNEL,
  AI_MAIL_SUBJECT_UNDO_CHANNEL,
  AI_MAIL_COMPOSE_TARGET_EVENT,
  AI_MAIL_COMPOSE_DIAGNOSTIC_CHANNEL
} from '../shared/ipc'
import {
  isAllowedAccountRequest,
  isAllowedAppInfoRequest,
  isAllowedGoogleConnectionRequest,
  isAllowedNotificationRequest,
  isAllowedSettingsRequest,
  isTrustedRendererUrl,
  isAllowedLoginLaunchRequest,
  isAllowedAiMailCodexRequest,
  isAllowedAiMailOllamaRequest,
  isAllowedProviderModelRequest,
  isAllowedClipboardWriteRequest,
  isAllowedOllamaCredentialRequest,
  isAllowedAiMailComposeTargetRequest,
  isAllowedAiMailComposeSelectionRequest,
  isAllowedAiMailComposeMutationRequest,
  isAllowedAiMailReadRequest,
  isAllowedAiMailReadLeaseRequest,
  isAllowedAiMailSubjectMutationRequest
} from './security-policy'
import type { createLoginLaunchController } from './login-launch'
import type { createAiMailCodexService } from './ai-mail-codex-service'
import type { createAiMailOllamaGenerationService } from './ai-mail-ollama-service'
import type { createOllamaService } from './ollama-service'
import type { createOllamaCredentialStore } from './ollama-credential-store'
import type { AiModelPort } from './ai-model-port'
import type { createGmailComposeTargetService } from './gmail-compose-target'
import type { createGmailReadTargetService } from './gmail-read-target'
import { isEvent } from './main-diagnostics-validation'

export interface MainIpcDependencies {
  readonly rendererUrl: string
  readonly window: () => BrowserWindow | null
  readonly views: () => ReturnType<typeof createAccountViewManager> | null
  readonly access: () => ReturnType<typeof createAccountAccessController> | null
  readonly notifications: () => ReturnType<typeof createNotificationConnectionController> | null
  readonly settings: () => ReturnType<typeof createSettingsStore> | null
  readonly writeClipboardText: (text: string) => void
  readonly isQuitting: () => boolean
  readonly requireAccountStore: () => ReturnType<typeof createAccountStore>
  readonly requireAccountRemoval: () => ReturnType<typeof createAccountRemovalController>
  readonly requireGoogleRuntime: () => ReturnType<typeof createGoogleConnectionRuntime>
  readonly recovery: ReturnType<typeof createNotificationRecoveryRuntime>
  readonly gmailCleanup: ReturnType<typeof createGmailCleanupRuntime>
  readonly unreadCounts: () => { unreadCounts: () => ReadonlyMap<string, number> }
  readonly locale: () => 'ko' | 'en'
  readonly activateView: (accountId: string) => void
  readonly publishAccountState: (owner: BrowserWindow, state: AccountState) => void
  readonly installAppMenu: () => void
  readonly createWindow: () => void
  readonly loginLaunch: ReturnType<typeof createLoginLaunchController>
  readonly aiMailCodex: ReturnType<typeof createAiMailCodexService>
  readonly aiMailOllama: ReturnType<typeof createAiMailOllamaGenerationService>
  readonly ollama: ReturnType<typeof createOllamaService>
  readonly aiModel: AiModelPort
  readonly ollamaCredentials: ReturnType<typeof createOllamaCredentialStore>
  readonly composeTarget: () => ReturnType<typeof createGmailComposeTargetService> | null
  readonly recordComposeDiagnostic: (accountId: string, event: AiMailComposeDiagnostic) => void
  readonly readTarget: () => ReturnType<typeof createGmailReadTargetService> | null
}

export function registerMainIpc(dependencies: MainIpcDependencies): void {
  ipcMain.handle(AI_MAIL_READ_SNAPSHOT_CURRENT_CHANNEL, async (event, ...args: unknown[]) => {
    const owner = dependencies.window()
    const request = {
      ownerAlive: Boolean(owner && !owner.isDestroyed()),
      senderMatches: Boolean(owner && event.sender === owner.webContents),
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      args
    }
    if (!owner || !isAllowedAiMailReadLeaseRequest(request)) throw new Error('Request rejected')
    const service = dependencies.readTarget()
    const current = service ? await service.isSnapshotCurrent(args[0] as string) : false
    if (
      dependencies.window() !== owner ||
      owner.isDestroyed() ||
      !isAllowedAiMailReadLeaseRequest({
        ...request,
        ownerAlive: true,
        senderMatches: event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? ''
      })
    )
      throw new Error('Request rejected')
    return current
  })
  ipcMain.handle(AI_MAIL_READ_SNAPSHOT_CHANNEL, async (event, ...args: unknown[]) => {
    const owner = dependencies.window()
    const trusted = isAllowedAiMailReadRequest({
      ownerAlive: Boolean(owner && !owner.isDestroyed()),
      senderMatches: Boolean(owner && event.sender === owner.webContents),
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      args
    })
    if (!trusted || !owner) throw new Error('Request rejected')
    const service = dependencies.readTarget()
    if (!service) return { status: 'access_locked' }
    const result = await service.getSnapshot()
    const stillCurrent =
      result.status !== 'ready' || (await service.isSnapshotCurrent(result.captureId))
    if (
      dependencies.window() !== owner ||
      owner.isDestroyed() ||
      !isAllowedAiMailReadRequest({
        ownerAlive: true,
        senderMatches: event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      })
    )
      throw new Error('Request rejected')
    return stillCurrent ? result : { status: 'stale' }
  })
  ipcMain.handle(AI_MAIL_COMPOSE_DIAGNOSTIC_CHANNEL, (event, ...args: unknown[]) => {
    const owner = dependencies.window()
    const trusted = isAllowedAiMailComposeTargetRequest({
      ownerAlive: Boolean(owner && !owner.isDestroyed()),
      senderMatches: Boolean(owner && event.sender === owner.webContents),
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      args: []
    })
    const value = args[0]
    if (
      !trusted ||
      args.length !== 1 ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value)
    )
      throw new Error('Request rejected')
    const diagnostic = value as Record<string, unknown>
    const keys = ['correlationId', 'stage', 'outcome', 'candidateCount', 'discovery', 'reason']
    if (Object.keys(diagnostic).some((key) => !keys.includes(key)))
      throw new Error('Request rejected')
    const currentOwner = dependencies.window()
    if (!owner || currentOwner !== owner || owner.isDestroyed()) throw new Error('Request rejected')
    const accountId = dependencies.requireAccountStore().getState().activeAccountId
    if (!accountId) return
    // The persisted-diagnostics validator is the single rule set for these fields
    // (including discovery.structure); a second copy here drifted and rejected valid events.
    if (!isEvent({ type: 'ai_mail.compose', accountId, ...diagnostic }))
      throw new Error('Request rejected')
    dependencies.recordComposeDiagnostic(accountId, diagnostic as AiMailComposeDiagnostic)
  })
  for (const [channel, operation] of [
    [AI_MAIL_SUBJECT_APPLY_CHANNEL, 'apply'],
    [AI_MAIL_SUBJECT_UNDO_CHANNEL, 'undo']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const request = {
        ownerAlive: Boolean(owner && !owner.isDestroyed()),
        senderMatches: Boolean(owner && event.sender === owner.webContents),
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args
      }
      if (!owner || !isAllowedAiMailSubjectMutationRequest(request))
        throw new Error('Request rejected')
      const service = dependencies.composeTarget()
      if (!service) return { status: 'stale_target' }
      const result =
        operation === 'apply'
          ? await service.applySubject(args[0] as import('../shared/ipc').AiMailComposeApplyRequest)
          : await service.undoSubject(args[0] as import('../shared/ipc').AiMailComposeUndoRequest)
      if (
        dependencies.window() !== owner ||
        owner.isDestroyed() ||
        !isAllowedAiMailSubjectMutationRequest({
          ...request,
          ownerAlive: true,
          senderMatches: event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? ''
        })
      )
        throw new Error('Request rejected')
      return result
    })
  }
  ipcMain.handle(AI_MAIL_COMPOSE_SELECT_TARGET_CHANNEL, async (event, ...args: unknown[]) => {
    const owner = dependencies.window()
    const request = {
      ownerAlive: Boolean(owner && !owner.isDestroyed()),
      senderMatches: Boolean(owner && event.sender === owner.webContents),
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      args
    }
    if (!isAllowedAiMailComposeSelectionRequest(request) || !owner)
      throw new Error('Request rejected')
    const service = dependencies.composeTarget()
    if (!service) return { status: 'access_locked' }
    const result = await service.selectTarget(
      args[0] as import('../shared/ipc').ComposeCandidateSelectionRequest
    )
    const trusted = (): boolean => {
      const current = dependencies.window()
      return Boolean(
        current === owner &&
        !owner.isDestroyed() &&
        isAllowedAiMailComposeSelectionRequest({
          ...request,
          ownerAlive: true,
          senderMatches: event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? ''
        })
      )
    }
    if (!trusted()) throw new Error('Request rejected')
    const resultCurrent =
      service.isResultCurrent(result) && (await service.isResultTargetCurrent(result))
    if (!trusted()) throw new Error('Request rejected')
    if (!resultCurrent) return { status: 'stale' }
    if (result.status === 'ready')
      owner.webContents.send(AI_MAIL_COMPOSE_TARGET_EVENT, {
        status: 'ready',
        accountId: result.accountId,
        composeId: result.composeId,
        accountLabel: result.accountLabel,
        recipients: result.recipients,
        subject: result.subject,
        candidates: result.candidates
      })
    return result
  })
  ipcMain.handle(CLIPBOARD_WRITE_TEXT_CHANNEL, (event, ...args: unknown[]) => {
    const owner = dependencies.window()
    if (
      !isAllowedClipboardWriteRequest({
        ownerAlive: Boolean(owner && !owner.isDestroyed()),
        senderMatches: Boolean(owner && event.sender === owner.webContents),
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      })
    )
      throw new Error('Request rejected')
    dependencies.writeClipboardText(args[0] as string)
  })
  for (const [channel, operation] of [
    [OLLAMA_CREDENTIAL_STATUS_CHANNEL, 'status'],
    [OLLAMA_CREDENTIAL_SET_CHANNEL, 'set'],
    [OLLAMA_CREDENTIAL_CLEAR_CHANNEL, 'clear']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const frame = event.senderFrame
      const frameUrl = frame?.url ?? ''
      const allowed = (): boolean =>
        Boolean(
          owner &&
          frame &&
          dependencies.window() === owner &&
          !owner.isDestroyed() &&
          event.sender === owner.webContents &&
          event.senderFrame === frame &&
          event.sender.mainFrame === frame &&
          frame.url === frameUrl &&
          isAllowedOllamaCredentialRequest(
            {
              ownerAlive: true,
              senderMatches: true,
              mainFrameMatches: true,
              senderUrl: frameUrl,
              rendererUrl: dependencies.rendererUrl,
              args
            },
            operation
          )
        )
      if (
        !isAllowedOllamaCredentialRequest(
          {
            ownerAlive: Boolean(owner && !owner.isDestroyed()),
            senderMatches: Boolean(owner && event.sender === owner.webContents),
            mainFrameMatches:
              event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
            senderUrl: event.senderFrame?.url ?? '',
            rendererUrl: dependencies.rendererUrl,
            args
          },
          operation
        )
      )
        throw new Error('Request rejected')
      if (!owner || !frame) throw new Error('Request rejected')
      if (operation === 'status') {
        const result = await dependencies.ollamaCredentials.has(args[0] as string)
        if (!allowed()) throw new Error('Request rejected')
        return result
      }
      const beforeCommit = (): void => {
        if (!allowed()) throw new Error('Request rejected')
      }
      if (operation === 'clear')
        await dependencies.ollamaCredentials.clear(args[0] as string, beforeCommit)
      else
        await dependencies.ollamaCredentials.set(args[0] as string, args[1] as string, beforeCommit)
      if (!allowed()) throw new Error('Request rejected')
      return undefined
    })
  }
  for (const [channel, operation] of [
    [AI_MAIL_COMPOSE_TARGET_STATUS_CHANNEL, 'status'],
    [AI_MAIL_COMPOSE_SNAPSHOT_CHANNEL, 'snapshot']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      if (
        !isAllowedAiMailComposeTargetRequest({
          ownerAlive,
          senderMatches: ownerAlive && event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl: dependencies.rendererUrl,
          args
        })
      )
        throw new Error('Request rejected')
      if (!owner) throw new Error('Request rejected')
      const service = dependencies.composeTarget()
      if (!service) return { status: 'access_locked' }
      const result =
        operation === 'status' ? await service.getStatus() : await service.getSnapshot()
      const targetStillCurrent = await service.isResultTargetCurrent(result)
      const currentOwner = dependencies.window()
      const requestStillTrusted =
        currentOwner === owner &&
        !owner.isDestroyed() &&
        isAllowedAiMailComposeTargetRequest({
          ownerAlive: true,
          senderMatches: event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl: dependencies.rendererUrl,
          args
        })
      if (!requestStillTrusted) throw new Error('Request rejected')
      if (!targetStillCurrent || !service.isResultCurrent(result)) return { status: 'stale' }
      const targetStatus =
        operation === 'status' || result.status !== 'ready'
          ? result
          : {
              status: 'ready' as const,
              accountId: result.accountId,
              composeId: result.composeId,
              accountLabel: result.accountLabel,
              recipients: result.recipients,
              subject: result.subject,
              candidates: result.candidates
            }
      owner.webContents.send(AI_MAIL_COMPOSE_TARGET_EVENT, targetStatus)
      return result
    })
  }
  for (const [channel, operation] of [
    [AI_MAIL_COMPOSE_APPLY_CHANNEL, 'apply'],
    [AI_MAIL_COMPOSE_UNDO_CHANNEL, 'undo']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const request = {
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args
      }
      if (!isAllowedAiMailComposeMutationRequest(request)) throw new Error('Request rejected')
      if (!owner) throw new Error('Request rejected')
      const service = dependencies.composeTarget()
      if (!service) return { status: 'stale_target' }
      const result =
        operation === 'apply'
          ? await service.applyDraft(args[0] as import('../shared/ipc').AiMailComposeApplyRequest)
          : await service.undoDraft(args[0] as import('../shared/ipc').AiMailComposeUndoRequest)
      const currentOwner = dependencies.window()
      if (
        currentOwner !== owner ||
        owner.isDestroyed() ||
        !isAllowedAiMailComposeMutationRequest({
          ...request,
          ownerAlive: true,
          senderMatches: event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? ''
        })
      )
        throw new Error('Request rejected')
      return result
    })
  }
  const codexRoutes = [
    [AI_MAIL_CODEX_STATUS_CHANNEL, 'status'],
    [AI_MAIL_CODEX_CONNECT_CHANNEL, 'connect'],
    [AI_MAIL_CODEX_DISCONNECT_CHANNEL, 'disconnect'],
    [AI_MAIL_CODEX_GENERATE_CHANNEL, 'generate'],
    [AI_MAIL_CODEX_CANCEL_CHANNEL, 'cancel']
  ] as const
  for (const [channel, operation] of codexRoutes) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const frame = event.senderFrame
      const frameUrl = frame?.url ?? ''
      const stillAllowed = (): boolean =>
        Boolean(
          owner &&
          frame &&
          dependencies.window() === owner &&
          !owner.isDestroyed() &&
          event.sender === owner.webContents &&
          event.senderFrame === frame &&
          event.sender.mainFrame === frame &&
          frame.url === frameUrl &&
          isAllowedAiMailCodexRequest({
            ownerAlive: true,
            senderMatches: true,
            mainFrameMatches: true,
            senderUrl: frameUrl,
            rendererUrl: dependencies.rendererUrl,
            operation,
            args
          })
        )
      if (
        !isAllowedAiMailCodexRequest({
          ownerAlive,
          senderMatches: ownerAlive && event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl: dependencies.rendererUrl,
          operation,
          args
        })
      )
        throw new Error('Request rejected')
      let result: unknown
      if (operation === 'status') result = await dependencies.aiMailCodex.getStatus()
      else if (operation === 'connect') result = await dependencies.aiMailCodex.connect()
      else if (operation === 'disconnect') result = await dependencies.aiMailCodex.disconnect()
      else if (operation === 'generate')
        result = await dependencies.aiMailCodex.generate(
          args[0] as import('../shared/ipc').CodexGenerationRequest
        )
      else result = await dependencies.aiMailCodex.cancel(args[0] as string)
      if (!stillAllowed()) throw new Error('Request rejected')
      return result
    })
  }
  for (const [channel, operation] of [
    [AI_MAIL_OLLAMA_GENERATE_CHANNEL, 'generate'],
    [AI_MAIL_OLLAMA_CANCEL_CHANNEL, 'cancel']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const request = {
        ownerAlive: Boolean(owner && !owner.isDestroyed()),
        senderMatches: Boolean(owner && event.sender === owner.webContents),
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args
      }
      if (!isAllowedAiMailOllamaRequest(request) || !owner) throw new Error('Request rejected')
      if (operation === 'cancel')
        return { cancelled: dependencies.aiMailOllama.cancel(args[0] as string) }
      const frame = event.senderFrame
      const frameUrl = frame?.url ?? ''
      const settingsStore = dependencies.settings()
      const generationRequest = args[0] as import('../shared/ipc').OllamaGenerationRequest
      return dependencies.aiMailOllama.generate(generationRequest, owner, () => {
        const liveOwner = dependencies.window()
        const settings = settingsStore?.get()
        const selectedModel =
          settings?.ollamaMode === 'remote' ? settings.ollamaRemoteModel : settings?.ollamaModel
        return (
          liveOwner === owner &&
          !owner.isDestroyed() &&
          dependencies.settings() === settingsStore &&
          event.sender === owner.webContents &&
          event.senderFrame === frame &&
          event.sender.mainFrame === frame &&
          frame?.url === frameUrl &&
          isTrustedRendererUrl(frameUrl, dependencies.rendererUrl) &&
          isAllowedAiMailOllamaRequest({
            ...request,
            ownerAlive: true,
            senderMatches: event.sender === owner.webContents,
            mainFrameMatches: event.senderFrame === frame && event.sender.mainFrame === frame,
            senderUrl: frameUrl
          }) &&
          settings?.aiMailProvider === 'ollama' &&
          selectedModel !== null
        )
      })
    })
  }
  for (const [channel, operation] of [
    [OLLAMA_STATUS_CHANNEL, 'status'],
    [OLLAMA_MODELS_CHANNEL, 'models'],
    [CODEX_MODELS_CHANNEL, 'codex-models']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      if (
        !isAllowedProviderModelRequest({
          ownerAlive,
          senderMatches: ownerAlive && event.sender === owner.webContents,
          mainFrameMatches:
            event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
          senderUrl: event.senderFrame?.url ?? '',
          rendererUrl: dependencies.rendererUrl,
          operation,
          args
        })
      )
        throw new Error('Request rejected')
      if (operation === 'status' || operation === 'models') {
        const settingsStore = dependencies.settings()
        const settings = settingsStore?.get()
        const frame = event.senderFrame
        const frameUrl = frame?.url ?? ''
        const stillAllowed = (): boolean =>
          Boolean(
            owner &&
            frame &&
            dependencies.window() === owner &&
            !owner.isDestroyed() &&
            (!settingsStore || dependencies.settings() === settingsStore) &&
            (!settingsStore || JSON.stringify(settingsStore.get()) === JSON.stringify(settings)) &&
            event.sender === owner.webContents &&
            event.senderFrame === frame &&
            event.sender.mainFrame === frame &&
            frame.url === frameUrl &&
            isAllowedProviderModelRequest({
              ownerAlive: true,
              senderMatches: true,
              mainFrameMatches: true,
              senderUrl: frameUrl,
              rendererUrl: dependencies.rendererUrl,
              operation,
              args
            })
          )
        const configuration = {
          provider: 'ollama' as const,
          mode: settings?.ollamaMode ?? 'local',
          endpoint: settings?.ollamaRemoteEndpoint ?? 'https://ollama.com/v1',
          apiKey:
            settings?.ollamaMode === 'remote'
              ? await dependencies.ollamaCredentials.get(settings.ollamaRemoteEndpoint)
              : null,
          model:
            settings?.ollamaMode === 'remote' ? settings.ollamaRemoteModel : settings?.ollamaModel
        }
        if (!stillAllowed()) throw new Error('Request rejected')
        if (operation === 'status') {
          const result = await dependencies.aiModel.getStatus(configuration)
          if (!stillAllowed()) throw new Error('Request rejected')
          return result
        }
        const models = await dependencies.aiModel.getModels(configuration)
        if (!stillAllowed()) throw new Error('Request rejected')
        return models.map((name) => ({ name, size: null }))
      }
      const result = await dependencies.aiMailCodex.getModels()
      const ownerAfter = dependencies.window()
      if (
        !owner ||
        ownerAfter !== owner ||
        owner.isDestroyed() ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error('Request rejected')
      return result
    })
  }
  for (const [channel, operation] of [
    [LOGIN_LAUNCH_GET_CHANNEL, 'get'],
    [LOGIN_LAUNCH_SET_CHANNEL, 'set']
  ] as const) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      const owner = dependencies.window()
      const ownerAlive = owner !== null && !owner.isDestroyed()
      const request = {
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      }
      if (!isAllowedLoginLaunchRequest(request, operation)) throw new Error('Request rejected')
      return operation === 'get'
        ? dependencies.loginLaunch.getState()
        : dependencies.loginLaunch.setEnabled(args[0] as boolean)
    })
  }
  ipcMain.handle(APP_INFO_CHANNEL, (event, ...args: unknown[]): AppInfo => {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    if (
      !isAllowedAppInfoRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        args
      })
    ) {
      throw new Error('Request rejected')
    }
    return {
      name: app.getName(),
      version: app.getVersion(),
      locale: app.getLocale().startsWith('ko') ? 'ko' : 'en'
    }
  })

  function accountRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation:
      | 'get'
      | 'add'
      | 'activate'
      | 'retry'
      | 'remove'
      | 'setDisplayName'
      | 'setColor'
      | 'setNotificationsEnabled'
      | 'move',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = typeof args[0] === 'string' ? args[0] : ''
    const state = dependencies.requireAccountStore().getState()
    return isAllowedAccountRequest({
      ownerAlive,
      senderMatches: ownerAlive && event.sender === owner.webContents,
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      operation,
      args,
      accountExists:
        operation === 'activate' ||
        operation === 'remove' ||
        operation === 'setDisplayName' ||
        operation === 'setColor' ||
        operation === 'setNotificationsEnabled' ||
        operation === 'move'
          ? state.accounts.some((account) => account.id === id)
          : operation === 'retry' && state.activeAccountId !== null
    })
  }

  function googleConnectionRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'connect' | 'cancel' | 'disconnect',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = args.length === 1 && typeof args[0] === 'string' ? args[0] : ''
    const accountExists = dependencies
      .requireAccountStore()
      .getState()
      .accounts.some((account) => account.id === id)
    return (
      !dependencies.isQuitting() &&
      !dependencies.requireAccountRemoval().isBusy() &&
      isAllowedGoogleConnectionRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args,
        accountExists
      })
    )
  }

  function notificationRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'recover' | 'cancel' | 'retry',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    const id = typeof args[0] === 'string' ? args[0] : ''
    const accountExists = dependencies
      .requireAccountStore()
      .getState()
      .accounts.some((account) => account.id === id)
    return (
      !dependencies.isQuitting() &&
      !dependencies.requireAccountRemoval().isBusy() &&
      isAllowedNotificationRequest({
        ownerAlive,
        senderMatches: ownerAlive && event.sender === owner.webContents,
        mainFrameMatches:
          event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
        senderUrl: event.senderFrame?.url ?? '',
        rendererUrl: dependencies.rendererUrl,
        operation,
        args,
        accountExists
      })
    )
  }

  ipcMain.handle(NOTIFICATION_CONNECTIONS_CHANNEL, (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    return dependencies.notifications()?.snapshot() ?? {}
  })
  ipcMain.handle(NOTIFICATION_RECOVER_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'recover', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.recover(args[0])
  })
  ipcMain.handle(NOTIFICATION_RECOVERY_CANCEL_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'cancel', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.cancel(args[0])
  })
  ipcMain.handle(NOTIFICATION_RETRY_CHANNEL, async (event, ...args: unknown[]) => {
    if (!notificationRequestAllowed(event, 'retry', args) || typeof args[0] !== 'string')
      throw new Error('Request rejected')
    await dependencies.notifications()?.retry(args[0])
  })

  const handleGoogleConnection = (
    channel: string,
    operation: 'get' | 'connect' | 'cancel' | 'disconnect'
  ): void => {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!googleConnectionRequestAllowed(event, operation, args))
        throw new Error('Request rejected')
      const accountId = args[0]
      const owner = dependencies.window()
      if (typeof accountId !== 'string' || !owner) throw new Error('Request rejected')
      const runtime = dependencies.requireGoogleRuntime()
      const accessController = dependencies.access()
      let result: Awaited<ReturnType<typeof runtime.getStatus>>
      if (operation === 'get') {
        result = await runtime.getStatus(accountId)
      } else {
        if (!accessController) throw new Error('Request rejected')
        const accessResult =
          operation === 'connect'
            ? await accessController.connect(accountId)
            : operation === 'cancel'
              ? await accessController.cancel(accountId)
              : await accessController.disconnect(accountId)
        result = { accountId, status: accessResult.connectionStatus }
      }
      if (
        dependencies.window() !== owner ||
        owner.isDestroyed() ||
        event.sender !== owner.webContents ||
        event.senderFrame === null ||
        event.senderFrame !== event.sender.mainFrame ||
        !isTrustedRendererUrl(event.senderFrame.url, dependencies.rendererUrl) ||
        !dependencies
          .requireAccountStore()
          .getState()
          .accounts.some((account) => account.id === accountId)
      )
        throw new Error('Request rejected')
      return result
    })
  }
  handleGoogleConnection(GOOGLE_CONNECTION_STATUS_CHANNEL, 'get')
  handleGoogleConnection(GOOGLE_CONNECTION_CONNECT_CHANNEL, 'connect')
  handleGoogleConnection(GOOGLE_CONNECTION_CANCEL_CHANNEL, 'cancel')
  handleGoogleConnection(GOOGLE_CONNECTION_DISCONNECT_CHANNEL, 'disconnect')

  ipcMain.handle(ACCOUNT_ACCESS_STATE_CHANNEL, (event, ...args: unknown[]) => {
    if (!googleConnectionRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const access = dependencies.access()
    if (typeof accountId !== 'string' || !access) throw new Error('Request rejected')
    return access.getState(accountId)
  })

  function settingsRequestAllowed(
    event: Electron.IpcMainInvokeEvent,
    operation: 'get' | 'update' | 'panel' | 'status-strip' | 'ai-mail-panel',
    args: unknown[]
  ): boolean {
    const owner = dependencies.window()
    const ownerAlive = owner !== null && !owner.isDestroyed()
    return isAllowedSettingsRequest({
      ownerAlive,
      senderMatches: ownerAlive && event.sender === owner.webContents,
      mainFrameMatches: event.senderFrame !== null && event.senderFrame === event.sender.mainFrame,
      senderUrl: event.senderFrame?.url ?? '',
      rendererUrl: dependencies.rendererUrl,
      operation,
      args
    })
  }
  ipcMain.handle(SETTINGS_GET_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'get', args)) {
      throw new Error('Request rejected')
    }
    const settingsStore = dependencies.settings()
    if (!settingsStore) throw new Error('Request rejected')
    return settingsStore.get()
  })
  let settingsUpdateQueue: Promise<void> = Promise.resolve()
  ipcMain.handle(SETTINGS_UPDATE_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'update', args)) {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    const frame = event.senderFrame
    const frameUrl = frame?.url ?? ''
    const requestStillAllowed = (settingsStore?: ReturnType<typeof createSettingsStore>): boolean =>
      Boolean(
        owner &&
        frame &&
        dependencies.window() === owner &&
        !owner.isDestroyed() &&
        (!settingsStore || dependencies.settings() === settingsStore) &&
        event.senderFrame === frame &&
        event.sender.mainFrame === frame &&
        frame.url === frameUrl &&
        isAllowedSettingsRequest({
          ownerAlive: true,
          senderMatches: event.sender === owner.webContents,
          mainFrameMatches: event.senderFrame === frame && event.sender.mainFrame === frame,
          senderUrl: frame.url,
          rendererUrl: dependencies.rendererUrl,
          operation: 'update',
          args
        })
      )
    const patch = args[0] as AppSettingsPatch
    const operation = settingsUpdateQueue.then(async () => {
      if (!requestStillAllowed()) throw new Error('Request rejected')
      const settingsStore = dependencies.settings()
      if (!settingsStore) throw new Error('Request rejected')
      const currentSettings = settingsStore.get()
      const snapshotCurrent = (): boolean =>
        dependencies.settings() === settingsStore &&
        JSON.stringify(settingsStore.get()) === JSON.stringify(currentSettings)
      const nextMode = patch.ollamaMode ?? currentSettings.ollamaMode ?? 'local'
      const nextProvider = patch.aiMailProvider ?? currentSettings.aiMailProvider
      const selectedModel =
        nextMode === 'remote'
          ? patch.ollamaRemoteModel === undefined
            ? currentSettings.ollamaRemoteModel
            : patch.ollamaRemoteModel
          : patch.ollamaModel === undefined
            ? currentSettings.ollamaModel
            : patch.ollamaModel
      const ollamaProviderChanged =
        patch.aiMailProvider === 'ollama' && currentSettings.aiMailProvider !== 'ollama'
      const ollamaModelChanged =
        (patch.ollamaModel !== undefined && patch.ollamaModel !== null) ||
        (patch.ollamaRemoteModel !== undefined && patch.ollamaRemoteModel !== null)
      if (ollamaProviderChanged && selectedModel === null)
        throw new Error('Select an available Ollama model first')
      if (
        nextProvider === 'ollama' &&
        ((nextMode === 'remote' && patch.ollamaRemoteModel === null) ||
          (nextMode === 'local' && patch.ollamaModel === null))
      )
        throw new Error('Select an available Ollama model first')
      if (ollamaModelChanged || ollamaProviderChanged) {
        if (!selectedModel) throw new Error('Select an available Ollama model first')
        const endpoint = patch.ollamaRemoteEndpoint ?? currentSettings.ollamaRemoteEndpoint
        const credential =
          nextMode === 'remote' ? await dependencies.ollamaCredentials.get(endpoint) : null
        if (!requestStillAllowed(settingsStore) || !snapshotCurrent())
          throw new Error('Request rejected')
        const configuration = {
          provider: 'ollama' as const,
          mode: nextMode,
          endpoint,
          apiKey: credential,
          model: selectedModel
        }
        if (nextMode === 'remote') {
          const models = await dependencies.aiModel.getModels(configuration)
          if (!requestStillAllowed(settingsStore) || !snapshotCurrent())
            throw new Error('Request rejected')
          if (!models.includes(selectedModel))
            throw new Error('Select an available Ollama model first')
        } else {
          await dependencies.ollama.validateModel(selectedModel)
        }
        if (!requestStillAllowed(settingsStore) || !snapshotCurrent())
          throw new Error('Request rejected')
      }

      const selectedCodexModel =
        patch.codexModel === undefined ? currentSettings.codexModel : patch.codexModel
      const codexProviderChanged =
        patch.aiMailProvider === 'codex' && currentSettings.aiMailProvider !== 'codex'
      if (
        ((patch.codexModel !== undefined && patch.codexModel !== null) || codexProviderChanged) &&
        selectedCodexModel !== null
      ) {
        const inventory = await dependencies.aiMailCodex.getModels()
        if (!requestStillAllowed(settingsStore) || !snapshotCurrent())
          throw new Error('Request rejected')
        if (
          inventory.state !== 'available' ||
          !inventory.models.some(
            (model) => model.id === selectedCodexModel || model.model === selectedCodexModel
          )
        )
          throw new Error('Select an available Codex model first')
      }
      if (!requestStillAllowed(settingsStore) || !snapshotCurrent())
        throw new Error('Request rejected')
      if (!owner) throw new Error('Request rejected')
      const settings = settingsStore.update(patch) // validated by the policy
      nativeTheme.themeSource = settings.theme
      dependencies.views()?.setLayout(settings.accountSelectorPosition, settings.sidebarCollapsed)
      for (const contents of webContents.getAllWebContents())
        dependencies.gmailCleanup.apply(contents)
      dependencies.installAppMenu()
      owner.webContents.send(SETTINGS_EVENT, settings)
      return settings
    })
    settingsUpdateQueue = operation.then(
      () => undefined,
      () => undefined
    )
    return operation
  })
  ipcMain.handle(SETTINGS_PANEL_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'panel', args)) throw new Error('Request rejected')
    return dependencies.views()?.setCovered(args[0] === true) ?? null
  })
  ipcMain.handle(ACCOUNT_STATUS_STRIP_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'status-strip', args)) throw new Error('Request rejected')
    dependencies.views()?.setStatusStripVisible(args[0] === true)
  })
  ipcMain.handle(AI_MAIL_PANEL_LAYOUT_CHANNEL, (event, ...args: unknown[]) => {
    if (!settingsRequestAllowed(event, 'ai-mail-panel', args)) throw new Error('Request rejected')
    dependencies.views()?.setAiMailPanelOpen(args[0] === true)
  })
  ipcMain.handle(UNREAD_COUNTS_CHANNEL, (event, ...args: unknown[]) => {
    if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    return Object.fromEntries(dependencies.unreadCounts().unreadCounts())
  })
  ipcMain.handle(ACCOUNT_STATE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'get', args)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().getState()
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_ADD_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'add', args)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().add()
    dependencies.composeTarget()?.onAccountSwitch()
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_ACTIVATE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'activate', args)) throw new Error('Request rejected')
    const id = args[0]
    if (typeof id !== 'string') throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().activate(id)
    dependencies.composeTarget()?.onAccountSwitch()
    if (state.activeAccountId) dependencies.activateView(state.activeAccountId)
    return state
  })
  ipcMain.handle(ACCOUNT_DISPLAY_NAME_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setDisplayName', args)) {
      throw new Error('Request rejected')
    }
    const accountId = args[0]
    const displayName = args[1]
    if (
      typeof accountId !== 'string' ||
      (displayName !== null && typeof displayName !== 'string')
    ) {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setDisplayName(accountId, displayName)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_COLOR_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setColor', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const color = args[1]
    if (typeof accountId !== 'string' || typeof color !== 'string')
      throw new Error('Request rejected')
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    if (!isAccountColor(color)) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setColor(accountId, color)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_NOTIFICATIONS_ENABLED_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'setNotificationsEnabled', args)) {
      throw new Error('Request rejected')
    }
    const [accountId, enabled] = args
    if (typeof accountId !== 'string' || typeof enabled !== 'boolean') {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().setNotificationsEnabled(accountId, enabled)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_MOVE_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'move', args)) throw new Error('Request rejected')
    const [accountId, toIndex] = args
    if (typeof accountId !== 'string' || typeof toIndex !== 'number') {
      throw new Error('Request rejected')
    }
    const owner = dependencies.window()
    if (!owner) throw new Error('Request rejected')
    const state = dependencies.requireAccountStore().move(accountId, toIndex)
    dependencies.publishAccountState(owner, state)
    return state
  })
  ipcMain.handle(ACCOUNT_RETRY_CHANNEL, (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'retry', args)) throw new Error('Request rejected')
    dependencies.views()?.retry()
  })
  ipcMain.handle(ACCOUNT_REMOVE_CHANNEL, async (event, ...args: unknown[]) => {
    dependencies.requireAccountRemoval().assertIdle()
    if (!accountRequestAllowed(event, 'remove', args)) throw new Error('Request rejected')
    const accountId = args[0]
    const owner = dependencies.window()
    const viewManager = dependencies.views()
    if (typeof accountId !== 'string' || !owner || !viewManager) {
      throw new Error('Request rejected')
    }
    const ownerIsAlive = (): boolean => dependencies.window() === owner && !owner.isDestroyed()
    const result = await dependencies.requireAccountRemoval().remove(accountId, {
      ownerIsAlive,
      async confirm(): Promise<boolean> {
        if (!ownerIsAlive()) return false
        const isKorean = dependencies.locale() === 'ko'
        const response = await dialog.showMessageBox(owner, {
          type: 'warning',
          title: isKorean ? '계정 삭제' : 'Remove account',
          message: isKorean ? '계정을 삭제할까요?' : 'Remove this account?',
          detail: isKorean
            ? '이 기기의 로그인 정보와 세션을 삭제합니다. Google 계정과 메일은 삭제되지 않습니다.'
            : 'This removes its local sign-in and session from this device. Your Google account and email are not deleted.',
          buttons: isKorean ? ['취소', '계정 삭제'] : ['Cancel', 'Remove account'],
          defaultId: 0,
          cancelId: 0,
          noLink: true
        })
        return response.response === 1
      },
      disposeView: (id) => viewManager.disposeAccount(id),
      activate: (id) => {
        dependencies.composeTarget()?.onAccountSwitch()
        if (!ownerIsAlive()) return
        try {
          viewManager.activate(id)
        } catch {
          if (!owner.isDestroyed()) {
            owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId: id, status: 'error' })
          }
        }
      }
    })
    if (result.outcome === 'removed' && typeof accountId === 'string') {
      dependencies.composeTarget()?.onAccountSwitch()
      viewManager.forgetLogoutLock(accountId)
      dependencies.access()?.forget(accountId)
      dependencies.recovery.clearPending(accountId)
      dependencies.notifications()?.disconnect(accountId)
    }
    if (result.outcome === 'failed' && ownerIsAlive()) {
      owner.webContents.send(ACCOUNT_VIEW_STATUS_EVENT, { accountId, status: 'error' })
    }
    return result
  })
}
