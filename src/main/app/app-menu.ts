import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import type { AppUpdateState } from './app-updates'

const TEXT = {
  ko: {
    settings: '설정…',
    view: '보기',
    copyLink: '링크 복사',
    open: 'Hantong 열기',
    quit: '종료',
    checkUpdates: '업데이트 확인…',
    restartUpdate: '재시작하여 업데이트…',
    checkingUpdates: '업데이트 확인 중…',
    downloadingUpdate: '업데이트 다운로드 중…',
    pauseNotifications: '알림 잠시 끄기',
    pausedNotifications: '알림 일시 중지됨',
    pause30Minutes: '30분 동안 끄기',
    pause1Hour: '1시간 동안 끄기',
    pauseUntilTomorrow: '내일 자정까지 끄기',
    resumeNotifications: '알림 다시 켜기'
  },
  en: {
    settings: 'Settings…',
    view: 'View',
    copyLink: 'Copy Link',
    open: 'Open Hantong',
    quit: 'Quit',
    checkUpdates: 'Check for Updates…',
    restartUpdate: 'Restart to Update…',
    checkingUpdates: 'Checking for Updates…',
    downloadingUpdate: 'Downloading Update…',
    pauseNotifications: 'Pause notifications',
    pausedNotifications: 'Paused until',
    pause30Minutes: 'Pause for 30 minutes',
    pause1Hour: 'Pause for 1 hour',
    pauseUntilTomorrow: 'Pause until tomorrow',
    resumeNotifications: 'Resume notifications'
  }
} as const

// Roles get OS-localized labels; only Hantong's own items need text here.
// No reload or developer-tools items: reloading would bypass the Gmail access gate.
export function buildAppMenuTemplate(
  locale: 'ko' | 'en',
  actions: {
    readonly openSettings: () => void
    readonly update?: {
      readonly state: AppUpdateState['kind']
      readonly check: () => void
      readonly restart: () => void
    }
    readonly notifications?: NotificationPauseMenuState
  }
): MenuItemConstructorOptions[] {
  const text = TEXT[locale]
  return [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: text.settings, accelerator: 'CommandOrControl+,', click: actions.openSettings },
        ...(actions.notifications
          ? [{ type: 'separator' as const }, pauseMenuItem(locale, actions.notifications)]
          : []),
        ...(actions.update
          ? [
              { type: 'separator' as const },
              {
                label:
                  actions.update.state === 'checking'
                    ? text.checkingUpdates
                    : actions.update.state === 'downloading'
                      ? text.downloadingUpdate
                      : text.checkUpdates,
                enabled: !['checking', 'downloading', 'ready', 'installing'].includes(
                  actions.update.state
                ),
                click: actions.update.check
              },
              ...(actions.update.state === 'ready'
                ? [{ label: text.restartUpdate, enabled: true, click: actions.update.restart }]
                : [])
            ]
          : []),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    {
      label: text.view,
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
}

type ContextParams = Pick<
  ContextMenuParams,
  'isEditable' | 'selectionText' | 'linkURL' | 'editFlags'
>

export function buildContextMenuTemplate(
  params: ContextParams,
  locale: 'ko' | 'en',
  actions: {
    readonly copyLink: (url: string) => void
    readonly isAllowedLink: (url: string) => boolean
  }
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  if (params.isEditable) {
    items.push(
      { role: 'undo', enabled: params.editFlags.canUndo },
      { role: 'redo', enabled: params.editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll }
    )
  } else if (params.selectionText.trim()) {
    items.push({ role: 'copy' })
  }
  const link = params.linkURL
  if (link && actions.isAllowedLink(link)) {
    if (items.length) items.push({ type: 'separator' })
    items.push({ label: TEXT[locale].copyLink, click: () => actions.copyLink(link) })
  }
  return items
}

export function buildTrayMenuTemplate(
  locale: 'ko' | 'en',
  actions: {
    readonly open: () => void
    readonly quit: () => void
    readonly notifications?: NotificationPauseMenuState
  }
): MenuItemConstructorOptions[] {
  const text = TEXT[locale]
  return [
    { label: text.open, click: actions.open },
    ...(actions.notifications ? [pauseMenuItem(locale, actions.notifications)] : []),
    { type: 'separator' },
    { label: text.quit, click: actions.quit }
  ]
}

interface NotificationPauseMenuState {
  readonly paused: boolean
  readonly pausedUntil: number | null
  readonly pause30: () => void
  readonly pause60: () => void
  readonly pauseTomorrow: () => void
  readonly resume: () => void
}

function pauseMenuItem(
  locale: 'ko' | 'en',
  state: NotificationPauseMenuState
): MenuItemConstructorOptions {
  const text = TEXT[locale]
  const pausedLabel =
    state.paused && state.pausedUntil !== null
      ? `${text.pausedNotifications} ${new Intl.DateTimeFormat(locale, {
          dateStyle: 'short',
          timeStyle: 'short'
        }).format(new Date(state.pausedUntil))}`
      : text.pausedNotifications
  return {
    label: text.pauseNotifications,
    submenu: state.paused
      ? [
          { label: pausedLabel, enabled: false },
          { type: 'separator' },
          { label: text.resumeNotifications, click: state.resume }
        ]
      : [
          { label: text.pause30Minutes, click: state.pause30 },
          { label: text.pause1Hour, click: state.pause60 },
          { label: text.pauseUntilTomorrow, click: state.pauseTomorrow }
        ]
  }
}
