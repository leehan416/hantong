import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountViewSnapshot } from '../../shared/ipc'
import type { AppSettings, AppSettingsPatch } from '../../shared/settings'
import type { SettingsSection } from './SettingsDialog'

export function useAppSettings(): {
  settings: AppSettings | null
  settingsOpen: boolean
  settingsBackground: AccountViewSnapshot | null
  settingsPanelFailed: boolean
  settingsFailed: boolean
  settingsSection: SettingsSection
  settingsDialogRef: React.RefObject<HTMLDialogElement | null>
  settingsButtonRef: React.RefObject<HTMLButtonElement | null>
  openSettings: () => Promise<void>
  closeSettings: () => Promise<void>
  changeSettings: (patch: AppSettingsPatch) => Promise<void>
  setSettings: (settings: AppSettings) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsSection: (section: SettingsSection) => void
  setSettingsBackground: (snapshot: AccountViewSnapshot | null) => void
  setSettingsPanelFailed: (failed: boolean) => void
} {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsBackground, setSettingsBackground] = useState<AccountViewSnapshot | null>(null)
  const [settingsPanelFailed, setSettingsPanelFailed] = useState(false)
  const [settingsFailed, setSettingsFailed] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general')
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null)
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null)
  const settingsReturnFocusRef = useRef<HTMLElement | null>(null)
  const settingsWasOpenRef = useRef(false)
  const settingsOpeningRef = useRef(false)

  const openSettings = useCallback(async (): Promise<void> => {
    if (settingsDialogRef.current?.open || settingsOpeningRef.current) return
    settingsOpeningRef.current = true
    const activeElement = document.activeElement
    settingsReturnFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : settingsButtonRef.current
    let panelSetupFailed = false
    try {
      setSettingsPanelFailed(false)
      let snapshot = await window.api.setSettingsPanelOpen(true)
      if (snapshot) {
        const image = new Image()
        image.src = snapshot.dataUrl
        try {
          await image.decode()
        } catch {
          snapshot = null
        }
      }
      setSettingsBackground(snapshot)
    } catch {
      setSettingsBackground(null)
      try {
        await window.api.setSettingsPanelOpen(false)
      } catch {
        panelSetupFailed = true
      }
    } finally {
      settingsOpeningRef.current = false
      if (panelSetupFailed) setSettingsPanelFailed(true)
      setSettingsOpen(true)
    }
  }, [])

  useEffect(() => {
    let active = true
    let unsubscribe = (): void => {}
    let unsubscribeOpen = (): void => {}
    try {
      unsubscribe = window.api.onSettings((next) => {
        if (active) setSettings(next)
      })
      unsubscribeOpen = window.api.onOpenSettings(() => {
        if (active) void openSettings()
      })
    } catch {
      // Without the push channel the panel still shows the values it saved itself.
    }
    void window.api.getSettings().then(
      (next) => {
        if (active) setSettings(next)
      },
      () => undefined
    )
    return () => {
      active = false
      unsubscribe()
      unsubscribeOpen()
    }
  }, [openSettings])

  useEffect(() => {
    const dialog = settingsDialogRef.current
    if (settingsOpen) {
      if (dialog && !dialog.open) dialog.showModal()
    } else {
      if (dialog?.open) dialog.close()
      if (settingsWasOpenRef.current) {
        const focusTarget = settingsReturnFocusRef.current ?? settingsButtonRef.current
        focusTarget?.focus()
        settingsReturnFocusRef.current = null
      }
    }
    settingsWasOpenRef.current = settingsOpen
  }, [settingsOpen])

  async function closeSettings(): Promise<void> {
    let panelCloseFailed = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await window.api.setSettingsPanelOpen(false)
        panelCloseFailed = false
        break
      } catch {
        panelCloseFailed = true
      }
    }
    if (panelCloseFailed) {
      setSettingsPanelFailed(true)
      return
    }
    setSettingsPanelFailed(false)
    try {
      setSettingsBackground(null)
      setSettingsOpen(false)
    } catch {
      setSettingsFailed(true)
    }
  }

  async function changeSettings(patch: AppSettingsPatch): Promise<void> {
    setSettingsFailed(false)
    try {
      setSettings(await window.api.updateSettings(patch))
    } catch {
      setSettingsFailed(true)
    }
  }

  return {
    settings,
    settingsOpen,
    settingsBackground,
    settingsPanelFailed,
    settingsFailed,
    settingsSection,
    settingsDialogRef,
    settingsButtonRef,
    openSettings,
    closeSettings,
    changeSettings,
    setSettings,
    setSettingsOpen,
    setSettingsSection,
    setSettingsBackground,
    setSettingsPanelFailed
  }
}
