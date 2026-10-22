import type { AppSettings, AppSettingsPatch } from '../../shared/settings'
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
    </div>
  )
}
