import {
  ACCOUNT_SELECTOR_POSITION_OPTIONS,
  GMAIL_CLEANUP_FIELDS,
  type AccountSelectorPosition,
  type AppSettings,
  type AppSettingsPatch
} from '../../shared/settings'
import type { AppMessages } from './app-messages'
import { SettingsRow } from './SettingsDialog'

export function AppearanceSettings({
  settings,
  position,
  text,
  failed,
  onChange
}: {
  settings: AppSettings | null
  position: AccountSelectorPosition
  text: AppMessages
  failed: boolean
  onChange: (patch: AppSettingsPatch) => void
}): React.JSX.Element {
  return (
    <div
      id="settings-panel-appearance"
      role="tabpanel"
      aria-labelledby="settings-tab-appearance"
      className="settings-tab-panel"
    >
      <SettingsRow label={text.theme}>
        <select
          className="settings-select"
          value={settings?.theme ?? 'system'}
          disabled={!settings}
          onChange={(event) => onChange({ theme: event.target.value as AppSettings['theme'] })}
        >
          {Object.entries(text.themeOptions).map(([value, optionLabel]) => (
            <option key={value} value={value}>
              {optionLabel}
            </option>
          ))}
        </select>
      </SettingsRow>
      <SettingsRow label={text.position}>
        <select
          className="settings-select"
          value={position}
          disabled={!settings}
          onChange={(event) =>
            onChange({ accountSelectorPosition: event.target.value as AccountSelectorPosition })
          }
        >
          {ACCOUNT_SELECTOR_POSITION_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {text.positions[option]}
            </option>
          ))}
        </select>
      </SettingsRow>
      <h3 className="settings-group-title">{text.gmailCleanup}</h3>
      {GMAIL_CLEANUP_FIELDS.map((field) => (
        <SettingsRow key={field} label={text.gmailCleanupOptions[field]}>
          <input
            className="settings-switch"
            type="checkbox"
            role="switch"
            checked={settings?.[field] === true}
            disabled={!settings}
            onChange={(event) => onChange({ [field]: event.target.checked })}
          />
        </SettingsRow>
      ))}
      {failed && (
        <p className="settings-error" role="alert">
          {text.settingsError}
        </p>
      )}
    </div>
  )
}
