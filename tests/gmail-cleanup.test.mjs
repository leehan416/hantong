/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes these tests as JavaScript. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { buildGmailCleanupCss } = loadTypeScript(
  new URL('../src/main/gmail-cleanup.ts', import.meta.url)
)
const off = {
  hideGmailLogo: false,
  hideGemini: false,
  hideSidePanel: false,
  hideStoragePromo: false
}

test('with every option off Gmail gets no stylesheet at all', () => {
  assert.equal(buildGmailCleanupCss(off), '')
})

test('each option hides only its own element', () => {
  const css = buildGmailCleanupCss({ ...off, hideGemini: true })
  assert.match(css, /button\[aria-label\*="Gemini"\]/)
  assert.doesNotMatch(css, /logo_gmail|complementary|\.aiG/)
  assert.match(css, /\{ display: none !important; \}$/)
})

test('enabled options combine into one rule and never touch scripts or mail content', () => {
  const css = buildGmailCleanupCss({
    hideGmailLogo: true,
    hideGemini: true,
    hideSidePanel: true,
    hideStoragePromo: true
  })
  for (const part of ['logo_gmail', 'Gemini', 'role="complementary"', '.aiG']) {
    assert.ok(css.includes(part), part)
  }
  assert.equal(css.split('{').length, 2)
  assert.doesNotMatch(css, /url\(|@import|expression|<script/i)
})
