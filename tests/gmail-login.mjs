/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Electron executes this manual JavaScript entry without a TypeScript loader. */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, session, shell } from 'electron'
import { loadTypeScript } from './helpers/load-typescript.mjs'

// Manual compatibility check, not part of the offline unit suite.
// No existing app profile, browser cookies, or OAuth credentials are imported.
app.setPath('userData', mkdtempSync(join(tmpdir(), 'hantong-gmail-login-')))
app.setName('Hantong Gmail login check')
const { createGmailView } = loadTypeScript(new URL('../src/main/gmail-view.ts', import.meta.url))

await app.whenReady()

const window = new BrowserWindow({
  title: 'Hantong — Gmail login check',
  width: 1100,
  height: 800,
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  }
})
const handle = createGmailView(session.fromPartition('hantong-gmail-login-check'), {
  openExternal: (url) => shell.openExternal(url),
  onNavigationBlocked: () => {
    console.error('Navigation blocked. No security workaround was applied.')
  }
})
window.contentView.addChildView(handle.view)

const resize = () => {
  const [width, height] = window.getContentSize()
  handle.view.setBounds({ x: 0, y: 0, width, height })
}
resize()
window.on('resize', resize)
window.on('closed', () => {
  handle.dispose()
  app.quit()
})
handle.view.webContents.on('did-finish-load', () => {
  void handle.view.webContents
    .executeJavaScript(
      `({
      node: typeof window.require,
      process: typeof window.process,
      api: typeof window.api,
      electron: typeof window.electron
    })`
    )
    .then((result) => {
      assert.deepEqual(result, {
        node: 'undefined',
        process: 'undefined',
        api: 'undefined',
        electron: 'undefined'
      })
      console.info('Page loaded without Node or Hantong bridge access. Verify sign-in manually.')
    })
    .catch(() => {
      console.error(
        'Page isolation verification failed or navigation changed. Close the check window.'
      )
    })
})

try {
  await handle.load()
} catch {
  console.error('Gmail did not finish loading. Check the network and the visible sign-in result.')
}
