import { useEffect, useRef, useState } from 'react'
import type { AppSettings, AppSettingsPatch } from '../../shared/settings'
import type { LoginLaunchState } from '../../shared/ipc'
import type { AppMessages } from './app-messages'
import { SettingsRow } from './SettingsDialog'

export function GeneralSettings({
  settings,
  text,
  failed,
  onChange
}: {
  settings: AppSettings | null
  text: AppMessages
  failed: boolean
  onChange: (patch: AppSettingsPatch) => void
}): React.JSX.Element {
  return (
    <div
      id="settings-panel-general"
      role="tabpanel"
      aria-labelledby="settings-tab-general"
      className="settings-tab-panel"
    >
      {(
        [
          ['language', text.language, text.languageOptions],
          ['closeAction', text.closeAction, text.closeActionOptions]
        ] as const
      ).map(([field, label, options]) => (
        <SettingsRow key={field} label={label}>
          <select
            className="settings-select"
            value={settings?.[field] ?? ''}
            disabled={!settings}
            onChange={(event) => onChange({ [field]: event.target.value })}
          >
            {Object.entries(options).map(([value, optionLabel]) => (
              <option key={value} value={value}>
                {optionLabel}
              </option>
            ))}
          </select>
        </SettingsRow>
      ))}
      {failed && (
        <p className="settings-error" role="alert">
          {text.settingsError}
        </p>
      )}
      <LoginLaunchSettingsRow text={text} />
    </div>
  )
}

function LoginLaunchSettingsRow({ text }: { text: AppMessages }): React.JSX.Element {
  const [state, setState] = useState<LoginLaunchState | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const sequence = useRef(0)
  const busyRef = useRef(false)
  const mounted = useRef(true)
  const refresh = async (): Promise<void> => {
    if (busyRef.current) return
    const current = ++sequence.current
    try {
      const result = await window.api.getLoginLaunchState()
      if (mounted.current && current === sequence.current) {
        setState(result)
        setFailed(false)
      }
    } catch {
      if (mounted.current && current === sequence.current) setFailed(true)
    }
  }
  useEffect(() => {
    mounted.current = true
    queueMicrotask(() => void refresh())
    const focus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', focus)
    const unsubscribeOpen = window.api.onOpenSettings(focus)
    const activeSequence = sequence
    return () => {
      mounted.current = false
      activeSequence.current++
      window.removeEventListener('focus', focus)
      unsubscribeOpen()
    }
  }, [])
  const change = async (enabled: boolean): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    const current = ++sequence.current
    setBusy(true)
    setFailed(false)
    try {
      const result = await window.api.setLoginLaunchEnabled(enabled)
      if (mounted.current && current === sequence.current) setState(result)
    } catch {
      if (mounted.current && current === sequence.current) {
        setState(null)
        try {
          const result = await window.api.getLoginLaunchState()
          if (mounted.current && current === sequence.current) setState(result)
        } catch {
          // Keep the control unknown when the OS readback also fails.
        }
        if (mounted.current && current === sequence.current) setFailed(true)
      }
    } finally {
      busyRef.current = false
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <>
      <SettingsRow label={text.launchAtLogin}>
        <input
          className="settings-switch"
          type="checkbox"
          role="switch"
          checked={state?.enabled ?? false}
          disabled={!state?.supported || busy || state.status === 'unavailable'}
          onChange={(event) => void change(event.target.checked)}
        />
      </SettingsRow>
      {!state?.supported && state && (
        <p className="settings-error">{text.launchLoginUnsupported}</p>
      )}
      {state?.status === 'not_found' && (
        <p className="settings-error">{text.loginItemNotFoundGuidance}</p>
      )}
      {state?.status === 'requires_approval' && (
        <p className="settings-error">{text.loginItemsGuidance}</p>
      )}
      {state?.supported && state.status === 'unavailable' && (
        <p className="settings-error" role="alert">
          {text.launchLoginError}{' '}
          <button className="settings-text-button" type="button" onClick={() => void refresh()}>
            {text.retry}
          </button>
        </p>
      )}
      {failed && (!state || !state.supported || state.status !== 'unavailable') && (
        <p className="settings-error" role="alert">
          {text.launchLoginError}{' '}
          <button className="settings-text-button" type="button" onClick={() => void refresh()}>
            {text.retry}
          </button>
        </p>
      )}
    </>
  )
}
