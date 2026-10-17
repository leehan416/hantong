/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { updateTrayUnreadCount } = loadTypeScript(
  new URL('../src/main/tray-unread-count.ts', import.meta.url)
)

test('macOS tray title shows the aggregate unread count', () => {
  const titles = []
  updateTrayUnreadCount(12, 'darwin', (title) => titles.push(title))
  assert.deepEqual(titles, ['12'])
})

test('zero unread messages clear the macOS tray title', () => {
  const titles = []
  updateTrayUnreadCount(0, 'darwin', (title) => titles.push(title))
  assert.deepEqual(titles, [''])
})

test('other platforms leave the tray title unchanged', () => {
  const titles = []
  updateTrayUnreadCount(3, 'linux', (title) => titles.push(title))
  assert.deepEqual(titles, [])
})
