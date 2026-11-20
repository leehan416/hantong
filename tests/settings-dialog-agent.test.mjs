/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JavaScript types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { AppDialog, SettingsDialog } = loadTypeScript(
  new URL('../src/renderer/src/SettingsDialog.tsx', import.meta.url),
  {
    'react/jsx-runtime': {
      Fragment: 'fragment',
      jsx: (type, props) => ({ type: typeof type === 'function' ? type(props) : type, props }),
      jsxs: (type, props) => ({ type: typeof type === 'function' ? type(props) : type, props })
    }
  }
)

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate)
      if (found) return found
    }
  }
  if (!node || typeof node !== 'object') return null
  if (predicate(node)) return node
  return find(node.props?.children, predicate)
}

test('settings navigation exposes the Agent section', () => {
  let selected
  let closed = 0
  const view = SettingsDialog({
    dialogRef: { current: null },
    section: 'agent',
    sectionTitles: {
      general: 'General',
      accounts: 'Accounts',
      appearance: 'Appearance',
      agent: 'Agent'
    },
    text: { settings: 'Settings', settingsClose: 'Close' },
    panelFailed: false,
    onSectionChange: (section) => {
      selected = section
    },
    onClose: () => {
      closed++
    },
    children: null
  })
  const tab = find(
    view,
    (element) => element.props?.role === 'tab' && element.props?.id === 'settings-tab-agent'
  )
  assert.ok(tab)
  assert.equal(tab.props['aria-selected'], true)
  tab.props.onClick()
  assert.equal(selected, 'agent')
  assert.equal(closed, 0)
  assert.equal(view.type.type, 'dialog')
  assert.match(view.type.props.className, /app-dialog/)
})

test('shared native dialog prevents implicit close and delegates Escape cancellation', () => {
  let cancelled = 0
  let prevented = false
  const dialog = AppDialog({
    dialogRef: { current: null },
    className: 'app-dialog test-dialog',
    ariaLabelledBy: 'test-title',
    onCancel: () => cancelled++,
    children: null
  })
  dialog.props.onCancel({ preventDefault: () => (prevented = true) })
  assert.equal(dialog.type, 'dialog')
  assert.equal(prevented, true)
  assert.equal(cancelled, 1)
})

test('AgentSettings scopes Ollama fields and status to the active provider including pending selection', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(
    new URL('../src/renderer/src/AgentSettings.tsx', import.meta.url),
    'utf8'
  )
  assert.match(source, /activeProvider === 'ollama' && settings\?\.ollamaMode === 'remote'/)
  assert.match(source, /activeProvider === 'ollama' && \(/)
  assert.match(source, /activeProvider === 'codex' && \(/)
  assert.match(source, /const activeProvider = pendingProvider \?\? settings\?\.aiMailProvider/)
  assert.match(source, /activeProvider === 'ollama'\s*\? await Promise\.all/)
})

test('Codex settings do not display the Ollama connection mode selector', () => {
  const { AgentSettings } = loadTypeScript(
    new URL('../src/renderer/src/AgentSettings.tsx', import.meta.url),
    { window: { api: {} } }
  )
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/app-messages.ts', import.meta.url)
  )
  const markup = ReactDOMServer.renderToStaticMarkup(
    React.createElement(AgentSettings, {
      settings: {
        aiMailProvider: 'codex',
        ollamaMode: 'local',
        ollamaRemoteEndpoint: 'https://ollama.com/v1',
        ollamaModel: null,
        ollamaRemoteModel: null,
        codexModel: null
      },
      text: messages.en,
      failed: false,
      onChange: async () => true
    })
  )
  assert.match(markup, /Codex/)
  assert.doesNotMatch(markup, /Ollama connection/)
})
