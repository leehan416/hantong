/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { buildMailNotificationOptions } = loadTypeScript(
  new URL('../src/main/mail-notification.ts', import.meta.url)
)

test('mail notification options include the app icon', () => {
  const options = buildMailNotificationOptions(
    { title: 'New mail', body: 'Hello' },
    '/assets/icon.png'
  )
  assert.equal(options.title, 'New mail')
  assert.equal(options.body, 'Hello')
  assert.equal(options.icon, '/assets/icon.png')
})

test('mail notifications pass the bundled app icon to Electron', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /new Notification\(buildMailNotificationOptions\(alert, trayIconPath\)\)/)
})
