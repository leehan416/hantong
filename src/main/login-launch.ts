import type { LoginLaunchState } from '../shared/ipc'

interface LoginItemSettings {
  openAtLogin: boolean
  status?: 'enabled' | 'not-registered' | 'requires-approval' | 'not-found'
}

export function createLoginLaunchController(adapter: {
  supported: boolean
  getLoginItemSettings: () => LoginItemSettings
  setLoginItemSettings: (settings: { openAtLogin: boolean }) => void
}): {
  getState: () => Promise<LoginLaunchState>
  setEnabled: (enabled: boolean) => Promise<LoginLaunchState>
} {
  const state = (): LoginLaunchState => {
    if (!adapter.supported) return { supported: false, enabled: false, status: 'unavailable' }
    const settings = adapter.getLoginItemSettings()
    if (settings.status === 'requires-approval')
      return { supported: true, enabled: true, status: 'requires_approval' }
    if (settings.status === 'not-found')
      return { supported: true, enabled: false, status: 'unavailable' }
    if (settings.status !== 'enabled' && settings.status !== 'not-registered')
      return { supported: true, enabled: false, status: 'unavailable' }
    return {
      supported: true,
      enabled: settings.openAtLogin,
      status: settings.openAtLogin ? 'enabled' : 'disabled'
    }
  }
  return {
    getState: async (): Promise<LoginLaunchState> => state(),
    setEnabled: async (enabled: boolean): Promise<LoginLaunchState> => {
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean')
      if (!adapter.supported) return state()
      adapter.setLoginItemSettings({ openAtLogin: enabled })
      const result = state()
      if (
        (enabled && result.status !== 'enabled' && result.status !== 'requires_approval') ||
        (!enabled && result.status !== 'disabled')
      )
        throw new Error('Login item change was not applied')
      return result
    }
  }
}
