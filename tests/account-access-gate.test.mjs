/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node test helpers use inferred JavaScript return types. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import React from 'react'
import ReactDOMServer from 'react-dom/server'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const module = { exports: {} }
const source = readFileSync(
  new URL('../src/renderer/src/AccountAccessGate.tsx', import.meta.url),
  'utf8'
)
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX
  }
})
runInNewContext(compiled.outputText, {
  exports: module.exports,
  module,
  require
})
const { AccountAccessGate } = module.exports
const noop = () => undefined

const text = {
  accessCheckingTitle: 'Preparing your mail',
  accessErrorTitle: 'Could not check access',
  accessRequiredTitle: 'Connect Gmail',
  accessChecking: 'Checking access',
  accessError: 'Access check failed',
  accessRequired: 'A connection is required',
  apiCheckError: 'Unable to check API connection status.',
  accessRetry: 'Retry',
  accessConnecting: 'Connecting',
  accessCancel: 'Cancel',
  apiCancelling: 'Cancelling',
  accessReopening: 'Reopening',
  accessReopen: 'Reopen',
  apiConnecting: 'Connecting API',
  apiReconnect: 'Reconnect'
}

function render({ loading, readFailed, status, connectionStatus = 'disconnected' }) {
  return ReactDOMServer.renderToStaticMarkup(
    React.createElement(AccountAccessGate, {
      accessState: {
        accountId: 'first',
        state: { accountId: 'first', status, connectionStatus },
        loading,
        readFailed
      },
      access: { accountId: 'first', status, connectionStatus },
      busy: false,
      googleOperation: null,
      text,
      onRetry: noop,
      onCancel: noop,
      onReconnect: noop,
      onReopen: noop
    })
  )
}

test('pending access checks replace stale errors and suppress recovery controls', () => {
  const markup = render({ loading: true, readFailed: true, status: 'error' })

  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /Preparing your mail/)
  assert.match(markup, /Checking access/)
  assert.doesNotMatch(markup, /Could not check access|Retry|Reconnect/)
})

test('settled access failures restore reconnect controls', () => {
  const markup = render({
    loading: false,
    readFailed: false,
    status: 'error',
    connectionStatus: 'error'
  })

  assert.match(markup, /aria-busy="false"/)
  assert.match(markup, /Could not check access/)
  assert.match(markup, /Reconnect/)
})

test('Main verification checking state suppresses stale reconnect controls', () => {
  const markup = render({
    loading: false,
    readFailed: false,
    status: 'checking',
    connectionStatus: 'connected'
  })

  assert.match(markup, /aria-busy="true"/)
  assert.match(markup, /Preparing your mail/)
  assert.doesNotMatch(markup, /Reconnect/)
})
