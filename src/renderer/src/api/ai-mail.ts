import type { HantongApi } from '~/shared/ipc'

export type AiMailApi = Pick<
  HantongApi,
  | 'getAiMailReadSnapshot'
  | 'isAiMailReadSnapshotCurrent'
  | 'applyAiMailSubject'
  | 'undoAiMailSubject'
  | 'getAiMailComposeTargetStatus'
  | 'getAiMailComposeSnapshot'
  | 'selectAiMailComposeTarget'
  | 'applyAiMailDraft'
  | 'undoAiMailDraft'
  | 'onAiMailComposeTarget'
  | 'recordAiMailComposeDiagnostic'
  | 'getAiMailCodexStatus'
  | 'connectAiMailCodex'
  | 'disconnectAiMailCodex'
  | 'generateAiMailDraft'
  | 'generateAiMailWithOllama'
  | 'cancelAiMailOllamaGeneration'
  | 'cancelAiMailGeneration'
  | 'onAiMailCodexStatus'
  | 'getOllamaStatus'
  | 'getOllamaModels'
>

export function getAiMailApi(): AiMailApi {
  return window.api
}
