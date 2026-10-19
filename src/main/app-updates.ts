export type AppUpdateState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'downloading'; readonly version?: string }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'installing' }
  | { readonly kind: 'failed'; readonly message: string }

export type UpdateNotice =
  | { readonly kind: 'latest' }
  | { readonly kind: 'progress' }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'failed'; readonly message: string }

interface UpdateEventMap {
  'update-available': (info: { readonly version: string }) => void
  'update-not-available': () => void
  'update-downloaded': (info: { readonly version: string }) => void
  error: (error: Error) => void
}

export interface AppUpdateDependencies {
  readonly enabled: boolean
  readonly updater: {
    checkForUpdates: () => Promise<{ readonly downloadPromise?: Promise<unknown> | null } | null>
    quitAndInstall: () => void
    on: <K extends keyof UpdateEventMap>(event: K, listener: UpdateEventMap[K]) => void
    off: <K extends keyof UpdateEventMap>(event: K, listener: UpdateEventMap[K]) => void
  }
  readonly prepareToInstall: () => Promise<void>
  readonly present: (notice: UpdateNotice) => Promise<'later' | 'restart'>
  readonly stateChanged: (state: AppUpdateState) => void
  readonly schedule: (callback: () => void, delay: number) => unknown
  readonly cancel: (timer: unknown) => void
}

const STARTUP_DELAY = 30_000
const CHECK_INTERVAL = 24 * 60 * 60 * 1000

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message || fallback
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = error.message
    if (typeof message === 'string' && message) return message
  }
  return fallback
}

export function createAppUpdateController(dependencies: AppUpdateDependencies): {
  readonly state: AppUpdateState
  check: (manual: boolean) => Promise<void>
  restart: () => Promise<void>
  dispose: () => void
} {
  let state: AppUpdateState = { kind: 'idle' }
  let disposed = false
  let checkPromise: Promise<void> | undefined
  let installPromise: Promise<void> | undefined
  let manualCheck = false
  let errorShown = false
  let readyDialog = false
  let activeTimer: unknown
  let timerDelay = STARTUP_DELAY
  let checkOutcome: 'latest' | 'available' | 'error' | undefined
  let installingVersion: string | undefined
  let downloadingVersion: string | undefined
  let checkId = 0
  let installingFailure: Error | undefined
  const currentState = (): AppUpdateState => state
  const setState = (next: AppUpdateState): void => {
    if (disposed) return
    state = next
    dependencies.stateChanged(next)
  }
  const present = async (notice: UpdateNotice): Promise<'later' | 'restart' | undefined> => {
    if (disposed) return undefined
    try {
      return await dependencies.present(notice)
    } catch {
      return undefined
    }
  }
  const offerReady = async (version: string): Promise<void> => {
    if (disposed || readyDialog) return
    readyDialog = true
    try {
      const choice = await present({ kind: 'ready', version })
      if (
        choice === 'restart' &&
        !disposed &&
        state.kind === 'ready' &&
        state.version === version
      ) {
        await restart()
      }
    } finally {
      readyDialog = false
    }
  }
  const onAvailable = (info: { readonly version: string }): void => {
    if (disposed || state.kind === 'installing') return
    checkOutcome = 'available'
    downloadingVersion = info.version
    setState({ kind: 'downloading', version: info.version })
  }
  const onNotAvailable = (): void => {
    if (!disposed && state.kind === 'checking') {
      checkOutcome = 'latest'
      setState({ kind: 'idle' })
    }
  }
  const onDownloaded = (info: { readonly version: string }): void => {
    if (disposed || state.kind === 'installing' || state.kind === 'failed') return
    if (state.kind === 'ready' && state.version === info.version) return
    if (state.kind !== 'checking' && state.kind !== 'downloading') return
    if (downloadingVersion && downloadingVersion !== info.version) return
    setState({ kind: 'ready', version: info.version })
    manualCheck = false
    void offerReady(info.version)
  }
  const onError = (error: Error): void => {
    if (disposed || state.kind === 'ready') return
    const message = errorMessage(error, 'Update failed')
    if (state.kind === 'installing' && installingVersion) {
      installingFailure = error
      setState({ kind: 'ready', version: installingVersion })
      installingVersion = undefined
      manualCheck = false
      void present({ kind: 'failed', message })
      return
    }
    checkOutcome = 'error'
    setState({ kind: 'failed', message })
    if (manualCheck && !errorShown) {
      errorShown = true
      void present({ kind: 'failed', message })
    }
    manualCheck = false
  }
  const listeners = {
    'update-available': onAvailable,
    'update-not-available': onNotAvailable,
    'update-downloaded': onDownloaded,
    error: onError
  }
  const armTimer = (): void => {
    if (disposed || !dependencies.enabled) return
    activeTimer = dependencies.schedule(() => {
      activeTimer = undefined
      void check(false).finally(() => {
        timerDelay = CHECK_INTERVAL
        armTimer()
      })
    }, timerDelay)
  }
  if (dependencies.enabled) {
    subscribe('update-available')
    subscribe('update-not-available')
    subscribe('update-downloaded')
    subscribe('error')
    armTimer()
  }
  function subscribe<K extends keyof UpdateEventMap>(event: K): void {
    dependencies.updater.on(event, listeners[event])
  }
  async function check(manual: boolean): Promise<void> {
    if (disposed || !dependencies.enabled) return
    if (state.kind === 'downloading') {
      if (manual) manualCheck = true
      if (manual) await present({ kind: 'progress' })
      return
    }
    if (state.kind === 'ready') {
      if (manual) await offerReady(state.version)
      return
    }
    if (state.kind === 'installing') return
    if (checkPromise) {
      manualCheck = manualCheck || manual
      return checkPromise
    }
    manualCheck = manual
    errorShown = false
    checkOutcome = undefined
    setState({ kind: 'checking' })
    checkPromise = (async () => {
      const activeCheckId = ++checkId
      try {
        const result = await dependencies.updater.checkForUpdates()
        // electron-updater resolves its check before automatic downloading finishes.
        if (result?.downloadPromise) checkOutcome = 'available'
        void result?.downloadPromise?.catch((error: unknown) => {
          if (activeCheckId === checkId)
            onError(error instanceof Error ? error : new Error('Update download failed'))
        })
        if (disposed) return
        if (state.kind === 'checking') {
          setState({ kind: 'idle' })
        }
        if (manualCheck && checkOutcome !== 'available' && checkOutcome !== 'error')
          await present({ kind: 'latest' })
      } catch (error) {
        if (disposed) return
        const message = errorMessage(error, 'Update check failed')
        checkOutcome = 'error'
        if (currentState().kind !== 'downloading' && currentState().kind !== 'ready')
          setState({ kind: 'failed', message })
        if (manualCheck && !errorShown) {
          errorShown = true
          await present({ kind: 'failed', message })
        }
      } finally {
        checkPromise = undefined
        if (currentState().kind !== 'downloading') manualCheck = false
      }
    })()
    return checkPromise
  }
  async function restart(): Promise<void> {
    if (disposed || state.kind !== 'ready' || installPromise) return installPromise
    const version = state.version
    installingFailure = undefined
    installingVersion = version
    setState({ kind: 'installing' })
    installPromise = (async () => {
      try {
        await dependencies.prepareToInstall()
        if (disposed || currentState().kind !== 'installing') return
        dependencies.updater.quitAndInstall()
      } catch (error) {
        if (!disposed) {
          setState({ kind: 'ready', version })
          installingVersion = undefined
          if (error === installingFailure) {
            installingFailure = undefined
            return
          }
          const message = errorMessage(error, 'Update restart failed')
          await present({ kind: 'failed', message })
        }
      } finally {
        installPromise = undefined
      }
    })()
    return installPromise
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    if (activeTimer !== undefined) dependencies.cancel(activeTimer)
    if (dependencies.enabled) {
      dependencies.updater.off('update-available', onAvailable)
      dependencies.updater.off('update-not-available', onNotAvailable)
      dependencies.updater.off('update-downloaded', onDownloaded)
      dependencies.updater.off('error', onError)
    }
  }
  return {
    get state() {
      return state
    },
    check,
    restart,
    dispose
  }
}
