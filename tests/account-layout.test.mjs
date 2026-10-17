import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this JavaScript test without a TypeScript loader. */
const { getAccountViewBounds } = loadTypeScript(
  new URL('../src/main/account-layout.ts', import.meta.url)
)
function bounds(value) {
  return JSON.parse(JSON.stringify(value))
}

test('top and bottom placements reserve the account chrome edge', () => {
  assert.deepEqual(bounds(getAccountViewBounds({ width: 900, height: 700, position: 'top' })), {
    x: 0,
    y: 88,
    width: 900,
    height: 612
  })
  assert.deepEqual(bounds(getAccountViewBounds({ width: 900, height: 700, position: 'bottom' })), {
    x: 0,
    y: 0,
    width: 900,
    height: 612
  })
})

test('left and right placements reserve the sidebar edge', () => {
  assert.deepEqual(bounds(getAccountViewBounds({ width: 900, height: 700, position: 'left' })), {
    x: 248,
    y: 32,
    width: 652,
    height: 668
  })
  assert.deepEqual(bounds(getAccountViewBounds({ width: 900, height: 700, position: 'right' })), {
    x: 0,
    y: 32,
    width: 652,
    height: 668
  })
})

test('hidden status strip releases its vertical space for every placement', () => {
  for (const position of ['top', 'bottom']) {
    const view = getAccountViewBounds({
      width: 900,
      height: 700,
      position,
      statusStripVisible: false
    })
    assert.deepEqual(bounds(view), {
      x: 0,
      y: position === 'top' ? 56 : 0,
      width: 900,
      height: 644
    })
  }
  for (const position of ['left', 'right']) {
    assert.deepEqual(
      bounds(
        getAccountViewBounds({
          width: 900,
          height: 700,
          position,
          statusStripVisible: false
        })
      ),
      { x: position === 'left' ? 248 : 0, y: 0, width: 652, height: 700 }
    )
  }
})

test('collapsed sidebars retain a narrow reopen rail without negative content bounds', () => {
  assert.deepEqual(
    bounds(
      getAccountViewBounds({ width: 900, height: 700, position: 'left', sidebarCollapsed: true })
    ),
    { x: 44, y: 32, width: 856, height: 668 }
  )
  assert.deepEqual(
    bounds(
      getAccountViewBounds({ width: 640, height: 480, position: 'right', sidebarCollapsed: true })
    ),
    { x: 0, y: 32, width: 596, height: 448 }
  )
})

test('invalid dimensions are clamped to non-negative bounds', () => {
  assert.deepEqual(bounds(getAccountViewBounds({ width: 200, height: 40, position: 'left' })), {
    x: 200,
    y: 32,
    width: 0,
    height: 8
  })
})
