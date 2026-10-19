/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { buildMailNotificationOptions } = loadTypeScript(
  new URL('../src/main/mail-notification.ts', import.meta.url)
)

test('mail notification options carry no icon (macOS shows it as a right-side image)', () => {
  const options = buildMailNotificationOptions({ title: 'New mail', body: 'Hello' })
  assert.equal(options.title, 'New mail')
  assert.equal(options.body, 'Hello')
  assert.equal('icon' in options, false)
})

test('mail notifications are built from the alert alone', async () => {
  const source = await readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  assert.match(source, /new Notification\(buildMailNotificationOptions\(alert\)\)/)
})
