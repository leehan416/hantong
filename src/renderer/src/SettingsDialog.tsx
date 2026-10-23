import type { RefObject } from 'react'
import type { AppMessages } from './app-messages'

export type SettingsSection = 'general' | 'accounts' | 'appearance'

export function SettingsRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="settings-row">
      <span className="settings-row-label">{label}</span>
      {children}
    </label>
  )
}

export function SettingsDialog({
  dialogRef,
  section,
  sectionTitles,
  text,
  panelFailed,
  onSectionChange,
  onClose,
  children
}: {
  dialogRef: RefObject<HTMLDialogElement | null>
  section: SettingsSection
  sectionTitles: Record<SettingsSection, string>
  text: AppMessages
  panelFailed: boolean
  onSectionChange: (section: SettingsSection) => void
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <dialog
      ref={dialogRef}
      className="settings-panel"
      aria-labelledby="settings-title"
      onCancel={(event) => event.preventDefault()}
    >
      <nav className="settings-navigation" aria-labelledby="settings-title" role="tablist">
        <h1 id="settings-title">{text.settings}</h1>
        {(['general', 'accounts', 'appearance'] as const).map((item) => (
          <button
            key={item}
            className="settings-navigation-item"
            type="button"
            role="tab"
            id={`settings-tab-${item}`}
            aria-selected={section === item}
            aria-controls={`settings-panel-${item}`}
            onClick={() => onSectionChange(item)}
          >
            {sectionTitles[item]}
          </button>
        ))}
      </nav>
      <section className="settings-content">
        <header className="settings-heading">
          <h2>{sectionTitles[section]}</h2>
          <button
            className="settings-close"
            type="button"
            aria-label={text.settingsClose}
            title={text.settingsClose}
            onClick={onClose}
          >
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {panelFailed && (
          <p className="settings-error" role="alert">
            {text.settingsError}
          </p>
        )}
        {children}
      </section>
    </dialog>
  )
}
