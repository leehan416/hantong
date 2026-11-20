import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountViewSnapshot } from '~/shared/ipc'
import type { AppSettings, AppSettingsPatch } from '~/shared/settings'
import type { SettingsSection } from '~/renderer/src/components/settings/SettingsDialog/SettingsDialog'

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
  changeSettings: (patch: AppSettingsPatch) => Promise<boolean>
  setSettings: (settings: AppSettings) => void
  setSettingsOpen: (open: boolean) => void
  setSettingsSection: (section: SettingsSection) => void
  setSettingsBackground: (snapshot: AccountViewSnapshot | null) => void
  setSettingsPanelFailed: (failed: boolean) => void
  acquireViewCover: (owner: string) => Promise<AccountViewSnapshot | null>
  releaseViewCover: (owner: string) => Promise<boolean>
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
  const settingsRevision = useRef(0)
  const viewCoverOwners = useRef(new Set<string>())
  const viewCoverSnapshot = useRef<AccountViewSnapshot | null>(null)
  const viewCoverTransition = useRef(Promise.resolve())

  const acquireViewCover = useCallback((owner: string): Promise<AccountViewSnapshot | null> => {
    const transition = async (): Promise<AccountViewSnapshot | null> => {
      if (viewCoverOwners.current.has(owner)) return viewCoverSnapshot.current
      if (viewCoverOwners.current.size > 0) {
        viewCoverOwners.current.add(owner)
        return viewCoverSnapshot.current
      }
      const snapshot = await window.api.setSettingsPanelOpen(true)
      viewCoverOwners.current.add(owner)
      viewCoverSnapshot.current = snapshot
      setSettingsBackground(snapshot)
      return snapshot
    }
    const next = viewCoverTransition.current.then(transition, transition)
    viewCoverTransition.current = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }, [])

  const releaseViewCover = useCallback((owner: string): Promise<boolean> => {
    const transition = async (): Promise<boolean> => {
      if (!viewCoverOwners.current.has(owner)) return true
      if (viewCoverOwners.current.size > 1) {
        viewCoverOwners.current.delete(owner)
        return true
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await window.api.setSettingsPanelOpen(false)
          viewCoverOwners.current.delete(owner)
          viewCoverSnapshot.current = null
          setSettingsBackground(null)
          return true
        } catch {
          // Keep the owner lease when the native view could not be restored.
        }
      }
      return false
    }
    const next = viewCoverTransition.current.then(transition, transition)
    viewCoverTransition.current = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }, [])

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
      const snapshot = await acquireViewCover('settings')
      if (snapshot) {
        const image = new Image()
        image.src = snapshot.dataUrl
        try {
          await image.decode()
        } catch {
          // A failed image decode must not release the native view cover early.
        }
      }
    } catch {
      try {
        if (!(await releaseViewCover('settings'))) panelSetupFailed = true
      } catch {
        panelSetupFailed = true
      }
    } finally {
      settingsOpeningRef.current = false
      if (panelSetupFailed) setSettingsPanelFailed(true)
      setSettingsOpen(true)
    }
  }, [acquireViewCover, releaseViewCover])

  useEffect(() => {
    let active = true
    let unsubscribe = (): void => {}
    let unsubscribeOpen = (): void => {}
    try {
      unsubscribe = window.api.onSettings((next) => {
        if (active) {
          settingsRevision.current += 1
          setSettings(next)
        }
      })
      unsubscribeOpen = window.api.onOpenSettings(() => {
        if (active) void openSettings()
      })
    } catch {
      // Without the push channel the panel still shows the values it saved itself.
    }
    void window.api.getSettings().then(
      (next) => {
        if (active && settingsRevision.current === 0) setSettings(next)
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
    const panelCloseFailed = !(await releaseViewCover('settings'))
    if (panelCloseFailed) {
      setSettingsPanelFailed(true)
      return
    }
    setSettingsPanelFailed(false)
    try {
      setSettingsOpen(false)
    } catch {
      setSettingsFailed(true)
    }
  }

  async function changeSettings(patch: AppSettingsPatch): Promise<boolean> {
    setSettingsFailed(false)
    const revision = ++settingsRevision.current
    try {
      const next = await window.api.updateSettings(patch)
      if (settingsRevision.current === revision) setSettings(next)
      return true
    } catch {
      setSettingsFailed(true)
      return false
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
    setSettingsPanelFailed,
    acquireViewCover,
    releaseViewCover
  }
}
