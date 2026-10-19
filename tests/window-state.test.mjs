/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { createWindowStateStore, fitWindowBounds, parseWindowState } = loadTypeScript(
  new URL('../src/main/window-state.ts', import.meta.url)
)
const laptop = { x: 0, y: 25, width: 1440, height: 875 }
const external = { x: 1440, y: 0, width: 2560, height: 1415 }

test('a window still on a connected display keeps its position and size', () => {
  const saved = { x: 1600, y: 100, width: 1200, height: 800 }
  assert.deepEqual({ ...fitWindowBounds(saved, [laptop, external]) }, saved)
})

test('a window left on an unplugged display falls back to the default placement', () => {
  assert.equal(fitWindowBounds({ x: 1600, y: 100, width: 1200, height: 800 }, [laptop]), null)
})

test('a title bar above or below every display is not considered visible', () => {
  assert.equal(fitWindowBounds({ x: 100, y: -500, width: 800, height: 600 }, [laptop]), null)
  assert.equal(fitWindowBounds({ x: 100, y: 890, width: 800, height: 600 }, [laptop]), null)
})

test('oversized and undersized windows are clamped to the display and the minimum size', () => {
  assert.deepEqual(
    { ...fitWindowBounds({ x: 0, y: 25, width: 3000, height: 2000 }, [laptop]) },
    { x: 0, y: 25, width: 1440, height: 875 }
  )
  assert.deepEqual(
    { ...fitWindowBounds({ x: 10, y: 30, width: 100, height: 100 }, [laptop]) },
    { x: 10, y: 30, width: 640, height: 480 }
  )
})

test('window state round-trips and a corrupt file reads as no saved state', () => {
  const directory = mkdtempSync(join(tmpdir(), 'hantong-window-'))
  try {
    const store = createWindowStateStore(directory)
    assert.equal(store.read(), null)
    const state = { bounds: { x: 1, y: 2, width: 900, height: 700 }, maximized: true }
    store.write(state)
    assert.deepEqual(JSON.parse(JSON.stringify(store.read())), state)
    writeFileSync(join(directory, 'window-state.json'), '{bad')
    assert.equal(store.read(), null)
    assert.equal(
      parseWindowState({ bounds: { x: 1.5, y: 0, width: 1, height: 1 }, maximized: false }),
      null
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
