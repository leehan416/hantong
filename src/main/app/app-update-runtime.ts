import { autoUpdater as nativeUpdater, dialog, type BrowserWindow } from 'electron'
import { EventEmitter } from 'node:events'
import { autoUpdater } from 'electron-updater'
import { createAppUpdateController, type AppUpdateState, type UpdateNotice } from './app-updates'

const FAILURE = {
  ko: '업데이트 중 문제가 발생했습니다. 나중에 다시 시도해 주세요.',
  en: 'There was a problem updating Hantong. Please try again later.'
} as const

export function createAppUpdateRuntime(options: {
  readonly enabled: boolean
  readonly version: string
  readonly locale: () => 'ko' | 'en'
  readonly parentWindow: () => BrowserWindow | undefined
  readonly onStateChanged: (state: AppUpdateState) => void
  readonly prepareToInstall: () => Promise<void>
}): {
  readonly controller: ReturnType<typeof createAppUpdateController>
  dispose: () => void
} {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = /-[0-9A-Za-z]/.test(options.version)
  const events = new EventEmitter()
  const forwardAvailable = (info: { readonly version: string }): void => {
    events.emit('update-available', info)
  }
  const forwardLatest = (): void => {
    events.emit('update-not-available')
  }
  const forwardDownloaded = (info: { readonly version: string }): void => {
    events.emit('update-downloaded', info)
  }
  const forwardError = (error: Error): void => {
    events.emit('error', error)
  }
  if (options.enabled) {
    autoUpdater.on('update-available', forwardAvailable)
    autoUpdater.on('update-not-available', forwardLatest)
    autoUpdater.on('update-downloaded', forwardDownloaded)
    autoUpdater.on('error', forwardError)
  }

  let disposed = false

  const controller = createAppUpdateController({
    enabled: options.enabled,
    updater: {
      checkForUpdates: () => autoUpdater.checkForUpdates(),
      quitAndInstall: () => autoUpdater.quitAndInstall(),
      on: (event, listener) => {
        events.on(event, listener)
      },
      off: (event, listener) => {
        events.off(event, listener)
      }
    },
    prepareToInstall: async () => {
      await stageNativeUpdate()
      if (disposed) throw new Error('Update runtime is disposed')
      await options.prepareToInstall()
    },
    stateChanged: options.onStateChanged,
    present: async (notice: UpdateNotice) => {
      const locale = options.locale()
      const parent = options.parentWindow()
      const show = (
        details: Electron.MessageBoxOptions
      ): Promise<Electron.MessageBoxReturnValue> =>
        parent ? dialog.showMessageBox(parent, details) : dialog.showMessageBox(details)
      if (notice.kind === 'latest') {
        await show({
          title: 'Hantong',
          message: locale === 'ko' ? '최신 버전을 사용하고 있습니다.' : 'Hantong is up to date.',
          buttons: [locale === 'ko' ? '확인' : 'OK'],
          noLink: true
        })
        return 'later'
      }
      if (notice.kind === 'progress') {
        await show({
          title: 'Hantong',
          message:
            locale === 'ko' ? '업데이트를 다운로드하고 있습니다.' : 'The update is downloading.',
          buttons: [locale === 'ko' ? '확인' : 'OK'],
          noLink: true
        })
        return 'later'
      }
      if (notice.kind === 'failed') {
        await show({
          title: 'Hantong',
          message: FAILURE[locale],
          buttons: [locale === 'ko' ? '확인' : 'OK'],
          noLink: true
        })
        return 'later'
      }
      const result = await show({
        title: 'Hantong',
        message:
          locale === 'ko'
            ? `버전 ${notice.version} 업데이트를 다운로드했습니다.`
            : `Version ${notice.version} is ready to install.`,
        buttons: [
          locale === 'ko' ? '나중에' : 'Later',
          locale === 'ko' ? '재시작하여 업데이트' : 'Restart to Update'
        ],
        defaultId: 1,
        cancelId: 0,
        noLink: true
      })
      return result.response === 1 ? 'restart' : 'later'
    },
    schedule: (callback, delay) => {
      const handle = setTimeout(callback, delay)
      return () => clearTimeout(handle)
    },
    cancel: (timer) => {
      if (typeof timer === 'function') timer()
    }
  })

  let staging = false
  let stagePromise: Promise<void> | undefined
  let cancelStaging: (() => void) | undefined
  async function stageNativeUpdate(): Promise<void> {
    if (disposed) throw new Error('Update runtime is disposed')
    if (staging) return
    if (stagePromise) return stagePromise
    let settle: ((error?: Error) => void) | undefined
    const task = new Promise<void>((resolve, reject) => {
      settle = (error?: Error): void => {
        clearTimeout(timeout)
        nativeUpdater.removeListener('update-downloaded', onDownloaded)
        nativeUpdater.removeListener('error', onError)
        cancelStaging = undefined
        stagePromise = undefined
        if (error) reject(error)
        else {
          staging = true
          resolve()
        }
      }
      const onDownloaded = (): void => settle?.()
      const onError = (error: Error): void => settle?.(error)
      const timeout = setTimeout(
        () => settle?.(new Error('Update verification timed out')),
        120_000
      )
      cancelStaging = () => settle?.(new Error('Update verification was cancelled'))
      nativeUpdater.once('update-downloaded', onDownloaded)
      nativeUpdater.once('error', onError)
    })
    stagePromise = task
    try {
      nativeUpdater.checkForUpdates()
    } catch (error) {
      settle?.(error instanceof Error ? error : new Error('Update verification failed'))
    }
    return task
  }

  return {
    controller,
    dispose: () => {
      if (disposed) return
      disposed = true
      cancelStaging?.()
      controller.dispose()
      if (options.enabled) {
        autoUpdater.off('update-available', forwardAvailable)
        autoUpdater.off('update-not-available', forwardLatest)
        autoUpdater.off('update-downloaded', forwardDownloaded)
        autoUpdater.off('error', forwardError)
      }
    }
  }
}
