import type { OllamaConnectionStatus } from '../shared/ipc'

export interface AiModelRequest {
  provider: 'ollama'
  mode: 'local' | 'remote'
  endpoint: string
  apiKey: string | null
  model: string
  accountId: string
  conversationId: string
  prompt: string
  isCurrent: () => boolean
}

export type AiModelConfiguration = Omit<
  AiModelRequest,
  'accountId' | 'conversationId' | 'prompt' | 'model' | 'isCurrent'
> & { model?: string | null }

export interface AiModelPort {
  getStatus(
    configuration: AiModelConfiguration,
    signal?: AbortSignal
  ): Promise<OllamaConnectionStatus>
  getModels(configuration: AiModelConfiguration, signal?: AbortSignal): Promise<string[]>
  generate(request: AiModelRequest, signal: AbortSignal): Promise<unknown>
  dispose(): Promise<void>
}
