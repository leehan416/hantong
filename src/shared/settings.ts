export const LANGUAGE_OPTIONS = ['system', 'ko', 'en'] as const
export const THEME_OPTIONS = ['system', 'light', 'dark'] as const
export const CLOSE_ACTION_OPTIONS = ['hide', 'quit'] as const
export const ACCOUNT_SELECTOR_POSITION_OPTIONS = ['top', 'bottom', 'left', 'right'] as const
export type AccountSelectorPosition = (typeof ACCOUNT_SELECTOR_POSITION_OPTIONS)[number]
export const ACCENT_COLOR_OPTIONS = ['blue', 'purple', 'green', 'orange', 'gray'] as const
// Gmail interface elements a user may hide; each is off by default so Gmail looks unchanged.
export const GMAIL_CLEANUP_FIELDS = [
  'hideGmailLogo',
  'hideGemini',
  'hideSidePanel',
  'hideStoragePromo'
] as const

export interface AppSettings {
  version: 1
  language: (typeof LANGUAGE_OPTIONS)[number]
  theme: (typeof THEME_OPTIONS)[number]
  // What closing the main window does; hiding keeps notifications running in the background.
  closeAction: (typeof CLOSE_ACTION_OPTIONS)[number]
  hideGmailLogo: boolean
  hideGemini: boolean
  hideSidePanel: boolean
  hideStoragePromo: boolean
  accountSelectorPosition: (typeof ACCOUNT_SELECTOR_POSITION_OPTIONS)[number]
  sidebarCollapsed: boolean
  accentColor: (typeof ACCENT_COLOR_OPTIONS)[number]
}

export type AppSettingsPatch = Partial<Omit<AppSettings, 'version'>>

export const DEFAULT_SETTINGS: AppSettings = Object.freeze({
  version: 1,
  language: 'system',
  theme: 'system',
  closeAction: 'hide',
  hideGmailLogo: false,
  hideGemini: false,
  hideSidePanel: false,
  hideStoragePromo: false,
  accountSelectorPosition: 'top',
  sidebarCollapsed: false,
  accentColor: 'blue'
})
