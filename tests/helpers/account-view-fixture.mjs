/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
import { EventEmitter } from 'node:events'
import { loadTypeScript } from './load-typescript.mjs'

export const firstId = '11111111-1111-4111-8111-111111111111'
export const secondId = '22222222-2222-4222-8222-222222222222'

export function fixture({
  deferLoads = false,
  loadTimeoutMs = 30_000,
  onLoadDiagnostic = () => {},
  onNavigationDiagnostic = () => {},
  onLoadStart = () => {}
} = {}) {
  const created = []
  const attached = []
  const detached = []
  const statuses = []
  const identityFailures = []
  const resolvers = []
  const accounts = [{ id: firstId }, { id: secondId }]
  let resizeHandler
  const window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 900, height: 700 }),
    on: (event, listener) => {
      if (event === 'resize') resizeHandler = listener
    },
    contentView: {
      addChildView: (view) => attached.push(view),
      removeChildView: (view) => detached.push(view)
    }
  }
  const store = {
    getState: () => ({
      version: 1,
      accounts,
      activeAccountId: firstId
    })
  }
  const manager = loadTypeScript(
    new URL('../../src/main/account-view-manager.ts', import.meta.url),
    {
      setTimeout,
      clearTimeout,
      './account-session': { getAccountSession: (id) => id },
      './gmail-view': {
        createGmailView: (session, callbacks) => {
          const webContents = new EventEmitter()
          webContents.url = 'https://mail.google.com/mail/u/0/'
          webContents.loadingMainFrame = false
          webContents.isDestroyed = () => false
          webContents.isLoadingMainFrame = () => webContents.loadingMainFrame
          webContents.getURL = () => webContents.url
          webContents.capturePage = async () => ({
            toDataURL: () => 'data:image/png;base64,bWFpbA=='
          })
          webContents.getTitle = () => 'Inbox - private@example.com - Gmail'
          const view = {
            session,
            callbacks,
            setBounds(bounds) {
              this.bounds = bounds
              this.boundsCount = (this.boundsCount ?? 0) + 1
            },
            getBounds() {
              return this.bounds
            },
            webContents
          }
          const handle = {
            view,
            loads: 0,
            disposeCount: 0,
            load: async () => {
              handle.loads += 1
              onLoadStart(view)
              if (deferLoads) {
                await new Promise((resolve) => resolvers.push(resolve))
              }
            },
            dispose: () => {
              handle.disposeCount += 1
              return Promise.resolve()
            },
            revokeMailAccess: () => {}
          }
          created.push(handle)
          return handle
        }
      }
    }
  ).createAccountViewManager(
    window,
    store,
    (status) => statuses.push(status),
    async () => {},
    loadTimeoutMs,
    (reason) => identityFailures.push(reason),
    onLoadDiagnostic,
    onNavigationDiagnostic
  )
  return {
    manager,
    created,
    attached,
    detached,
    statuses,
    identityFailures,
    onLoadDiagnostic,
    accounts,
    window,
    resolvers,
    resize: () => resizeHandler?.()
  }
}
