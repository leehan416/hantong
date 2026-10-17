/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { buildAppMenuTemplate, buildContextMenuTemplate, buildTrayMenuTemplate } = loadTypeScript(
  new URL('../src/main/app-menu.ts', import.meta.url)
)
const allFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true
}
const base = { isEditable: false, selectionText: '', linkURL: '', editFlags: allFlags }
const actions = (copied = []) => ({
  copyLink: (url) => copied.push(url),
  isAllowedLink: (url) => url.startsWith('https:')
})
// Templates come from the VM realm; copy into this realm before deep comparisons.
const roles = (items) => [...items].map((item) => item.role ?? item.type ?? item.label)

test('app menu opens settings with Cmd+, and offers no reload or developer tools', () => {
  let opened = 0
  const template = buildAppMenuTemplate('ko', { openSettings: () => (opened += 1) })
  const settings = template[0].submenu.find((item) => item.accelerator === 'CommandOrControl+,')
  assert.equal(settings.label, '설정…')
  settings.click()
  assert.equal(opened, 1)
  assert.deepEqual(roles(template), ['appMenu', 'editMenu', '보기', 'windowMenu'])
  const all = JSON.stringify(template)
  for (const forbidden of ['reload', 'forceReload', 'toggleDevTools']) {
    assert.equal(all.includes(forbidden), false)
  }
  assert.equal(buildAppMenuTemplate('en', { openSettings: () => undefined })[2].label, 'View')
})

test('editable fields get edit actions gated by the page edit flags', () => {
  const items = buildContextMenuTemplate({ ...base, isEditable: true }, 'en', actions())
  assert.deepEqual(roles(items), ['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'selectAll'])
  assert.equal(items[1].enabled, false)
})

test('selected text offers copy; empty context offers nothing', () => {
  assert.deepEqual(
    roles(buildContextMenuTemplate({ ...base, selectionText: 'hi' }, 'en', actions())),
    ['copy']
  )
  assert.equal(
    buildContextMenuTemplate({ ...base, selectionText: '  ' }, 'en', actions()).length,
    0
  )
})

test('only allowed links can be copied', () => {
  const copied = []
  const items = buildContextMenuTemplate(
    { ...base, selectionText: 'x', linkURL: 'https://example.com/' },
    'ko',
    actions(copied)
  )
  assert.deepEqual(roles(items), ['copy', 'separator', '링크 복사'])
  items[2].click()
  assert.deepEqual([...copied], ['https://example.com/'])
  assert.equal(
    buildContextMenuTemplate({ ...base, linkURL: 'javascript:alert(1)' }, 'en', actions()).length,
    0
  )
})

test('tray menu reopens the window and quits explicitly, in the chosen language', () => {
  const calls = []
  const template = buildTrayMenuTemplate('ko', {
    open: () => calls.push('open'),
    quit: () => calls.push('quit')
  })
  assert.deepEqual(roles(template), ['Hantong 열기', 'separator', '종료'])
  template[0].click()
  template[2].click()
  assert.deepEqual([...calls], ['open', 'quit'])
  assert.equal(
    buildTrayMenuTemplate('en', { open: () => undefined, quit: () => undefined })[2].label,
    'Quit'
  )
})
