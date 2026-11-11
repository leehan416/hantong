import type {
  CodexConnectionStatus,
  CodexGenerationRequest,
  CodexGenerationResult
} from '../shared/ipc'

/**
 * The app-server protocol was proven in #35, but the repository has no
 * product-owned Codex executable or provisioning path. Never resolve `codex`
 * from PATH: that could attach this app to the user's normal installation.
 */
export function createAiMailCodexService(): {
  getStatus: () => CodexConnectionStatus
  connect: () => Promise<CodexConnectionStatus>
  disconnect: () => Promise<CodexConnectionStatus>
  generate: (request: CodexGenerationRequest) => Promise<CodexGenerationResult>
  cancel: (requestId: string) => Promise<{ cancelled: false; reason: string }>
  dispose: () => Promise<void>
} {
  let status: CodexConnectionStatus = {
    state: 'unsupported',
    reason: 'product_owned_executable_unavailable'
  }

  return {
    getStatus: (): CodexConnectionStatus => status,
    connect: async (): Promise<CodexConnectionStatus> => status,
    disconnect: async (): Promise<CodexConnectionStatus> => status,
    generate: async (request: CodexGenerationRequest): Promise<CodexGenerationResult> => {
      void request
      return {
        ok: false,
        error: 'unsupported',
        reason: 'product_owned_executable_unavailable'
      }
    },
    cancel: async (requestId: string): Promise<{ cancelled: false; reason: string }> => {
      void requestId
      return { cancelled: false, reason: 'unsupported' }
    },
    dispose: async (): Promise<void> => {
      status = { state: 'disconnected' }
    }
  }
}
