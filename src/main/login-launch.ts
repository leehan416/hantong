import type { LoginLaunchState } from '../shared/ipc'
import type { LoginLaunchDiagnosticEvent } from './main-diagnostics-types'

interface LoginItemSettings {
  openAtLogin: boolean
  status?: string
}

export function createLoginLaunchController(adapter: {
  supported: boolean
  getLoginItemSettings: () => LoginItemSettings
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void
  confirmEnable?: () => Promise<boolean | undefined>
  promptSeen?: () => boolean
  markPromptSeen?: () => void
  ownerAlive?: () => boolean
  onDiagnostic?: (event: LoginLaunchDiagnosticEvent) => void
}): {
  getState: () => Promise<LoginLaunchState>
  setEnabled: (enabled: boolean) => Promise<LoginLaunchState>
} {
  let enablePending: Promise<LoginLaunchState> | undefined
  let requestGeneration = 0
  const report = (event: LoginLaunchDiagnosticEvent): void => {
    try {
      adapter.onDiagnostic?.(event)
    } catch {
      // Diagnostic failures must not interrupt native login-item operations.
    }
  }
  const state = (
    operation: 'read' | 'readback' = 'read',
    requestedEnabled?: boolean
  ): LoginLaunchState => {
    if (!adapter.supported) return { supported: false, enabled: false, status: 'unavailable' }
    let settings: LoginItemSettings
    try {
      settings = adapter.getLoginItemSettings()
    } catch (error) {
      report({
        type: 'login.launch',
        operation,
        ...(requestedEnabled !== undefined ? { requestedEnabled } : {}),
        status: 'missing',
        outcome: 'failure'
      })
      throw error
    }
    let status: LoginLaunchDiagnosticEvent['status']
    switch (settings.status) {
      case 'enabled':
      case 'not-registered':
      case 'requires-approval':
      case 'not-found':
        status = settings.status
        break
      case undefined:
        status = 'missing'
        break
      default:
        status = 'unknown'
    }
    let result: LoginLaunchState
    if (settings.status === 'requires-approval')
      result = { supported: true, enabled: true, status: 'requires_approval' }
    else if (settings.status === 'not-found')
      result = { supported: true, enabled: false, status: 'not_found' }
    else if (settings.status !== 'enabled' && settings.status !== 'not-registered')
      result = { supported: true, enabled: false, status: 'unavailable' }
    else
      result = {
        supported: true,
        enabled: settings.openAtLogin,
        status: settings.openAtLogin ? 'enabled' : 'disabled'
      }
    const matches =
      operation !== 'readback' ||
      (requestedEnabled === true
        ? result.status === 'enabled' || result.status === 'requires_approval'
        : result.status === 'disabled')
    report({
      type: 'login.launch',
      operation,
      ...(requestedEnabled !== undefined ? { requestedEnabled } : {}),
      openAtLogin: settings.openAtLogin,
      status,
      outcome: matches ? 'success' : 'mismatch'
    })
    return result
  }
  return {
    getState: async (): Promise<LoginLaunchState> => state(),
    setEnabled: async (enabled: boolean): Promise<LoginLaunchState> => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      if (!adapter.supported) return state()
      if (enabled) {
        if (enablePending) return enablePending
        const generation = ++requestGeneration
        const operation = (async (): Promise<LoginLaunchState> => {
          if (adapter.confirmEnable) {
            const current = state()
            if (current.enabled) return current
            if (adapter.promptSeen?.()) return register(true)
            const confirmed = await adapter.confirmEnable()
            if (generation !== requestGeneration) return state()
            if (adapter.ownerAlive && !adapter.ownerAlive()) return state()
            if (confirmed === undefined) return state()
            adapter.markPromptSeen?.()
            if (!confirmed) return state()
            const afterPrompt = state()
            if (afterPrompt.enabled || (adapter.ownerAlive && !adapter.ownerAlive()))
              return afterPrompt
          }
          return register(true)
        })()
        enablePending = operation
        try {
          return await operation
        } finally {
          enablePending = undefined
        }
      }
      requestGeneration++
      return register(false)
    }
  }

  async function register(enabled: boolean): Promise<LoginLaunchState> {
    try {
      adapter.setLoginItemSettings({ openAtLogin: enabled })
      report({
        type: 'login.launch',
        operation: 'set',
        requestedEnabled: enabled,
        outcome: 'returned'
      })
    } catch (error) {
      report({
        type: 'login.launch',
        operation: 'set',
        requestedEnabled: enabled,
        outcome: 'failure'
      })
      throw error
    }
    const result = state('readback', enabled)
    if (
      (enabled && result.status !== 'enabled' && result.status !== 'requires_approval') ||
      (!enabled && result.status !== 'disabled')
    )
      throw new Error('Login item change was not applied')
    return result
  }
}
