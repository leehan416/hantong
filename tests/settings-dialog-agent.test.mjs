/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node tests use inferred JavaScript types. */
import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { AppDialog, SettingsDialog } = loadTypeScript(
  new URL(
    '../src/renderer/src/components/settings/SettingsDialog/SettingsDialog.tsx',
    import.meta.url
  ),
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
    new URL(
      '../src/renderer/src/components/settings/AgentSettings/AgentSettings.tsx',
      import.meta.url
    ),
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
    new URL(
      '../src/renderer/src/components/settings/AgentSettings/AgentSettings.tsx',
      import.meta.url
    ),
    { window: { api: {} } }
  )
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/messages/app-messages.ts', import.meta.url)
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

test('stale persisted local model keeps the Ollama picker reachable from Codex', async () => {
  const hooks = (() => {
    const slots = []
    const effects = []
    let index = 0
    return {
      beginRender() {
        index = 0
        effects.length = 0
      },
      useState(initial) {
        const slot = index++
        slots[slot] ??= { value: initial }
        return [slots[slot].value, (value) => (slots[slot].value = value)]
      },
      useRef(initial) {
        const slot = index++
        slots[slot] ??= { value: { current: initial } }
        return slots[slot].value
      },
      useCallback(callback) {
        index++
        return callback
      },
      useEffect(callback) {
        index++
        effects.push(callback)
      },
      flushEffects() {
        for (const effect of effects.splice(0)) effect()
      }
    }
  })()
  const { AgentSettings } = loadTypeScript(
    new URL(
      '../src/renderer/src/components/settings/AgentSettings/AgentSettings.tsx',
      import.meta.url
    ),
    {
      react: hooks,
      window: {
        api: {
          getOllamaStatus: async () => ({ state: 'available', cloudDisabled: true }),
          getOllamaModels: async () => [{ name: 'gemma4:e2b', size: 1 }],
          getOllamaCredentialStatus: async () => false,
          getAiMailCodexStatus: async () => ({ state: 'connected' }),
          getCodexModels: async () => ({ state: 'available', models: [] }),
          onAiMailCodexStatus: () => () => undefined
        }
      },
      '../SettingsDialog/SettingsDialog': { SettingsRow: (props) => ({ type: 'row', props }) }
    }
  )
  const { messages } = loadTypeScript(
    new URL('../src/renderer/src/messages/app-messages.ts', import.meta.url)
  )
  const settings = {
    aiMailProvider: 'codex',
    ollamaMode: 'local',
    ollamaRemoteEndpoint: 'https://ollama.com/v1',
    ollamaModel: 'qwen3:8b',
    ollamaRemoteModel: null,
    codexModel: null
  }
  const patches = []
  const props = {
    settings,
    text: messages.en,
    failed: false,
    onChange: async (patch) => {
      patches.push(patch)
      return true
    }
  }
  const render = () => {
    hooks.beginRender()
    const tree = AgentSettings(props)
    hooks.flushEffects()
    return tree
  }
  const find = (node, predicate) => {
    if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean)
    if (!node || typeof node !== 'object') return null
    if (predicate(node)) return node
    const children = node.props?.children
    return Array.isArray(children)
      ? children.map((child) => find(child, predicate)).find(Boolean)
      : find(children, predicate)
  }
  render()
  await new Promise(setImmediate)
  let tree = render()
  find(tree, (node) => node.type === 'select' && node.props.value === 'codex').props.onChange({
    target: { value: 'ollama' }
  })
  tree = render()
  assert.ok(find(tree, (node) => node.type === 'select' && node.props.value === ''))
  assert.deepEqual(patches, [])
  find(tree, (node) => node.type === 'select' && node.props.value === '').props.onChange({
    target: { value: 'gemma4:e2b' }
  })
  await new Promise(setImmediate)
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [
    { ollamaModel: 'gemma4:e2b', aiMailProvider: 'ollama' }
  ])
})
