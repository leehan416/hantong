import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Compile only the pure policy module; no Electron process or network is needed.
const source = readFileSync(new URL('../src/main/security-policy.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
})
const policy = {}
runInNewContext(compiled.outputText, { exports: policy, URL })

const rendererUrl =
  'file:///Applications/Hantong.app/Contents/Resources/app/out/renderer/index.html'

test('only the exact local renderer document and its hash are trusted', () => {
  assert.equal(policy.isTrustedRendererUrl(rendererUrl, rendererUrl), true)
  assert.equal(policy.isTrustedRendererUrl(`${rendererUrl}#content`, rendererUrl), true)
  for (const url of [
    `${rendererUrl}?redirect=1`,
    rendererUrl.replace('index.html', 'other.html'),
    'https://mail.google.com/',
    'file:///tmp/index.html',
    'about:blank',
    'not a URL'
  ]) {
    assert.equal(policy.isTrustedRendererUrl(url, rendererUrl), false, url)
  }
})

test('development trust is limited to the exact configured document', () => {
  const devUrl = 'http://localhost:5173/'
  assert.equal(policy.isTrustedRendererUrl(`${devUrl}#content`, devUrl), true)
  for (const url of [
    'http://localhost:5174/',
    'http://localhost:5173/other',
    'http://localhost:5173/?query=1',
    'http://user:password@localhost:5173/',
    'https://localhost:5173/'
  ]) {
    assert.equal(policy.isTrustedRendererUrl(url, devUrl), false, url)
  }
})

test('external opening accepts only explicit HTTPS or mailto targets', () => {
  for (const url of ['https://example.com/path', 'mailto:hello@example.com']) {
    assert.equal(policy.isAllowedExternalUrl(url), true, url)
  }
  for (const url of [
    'http://example.com',
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///tmp/file',
    'https://user:password@example.com',
    'https://example.com\n',
    'mailto:',
    'not a URL',
    null,
    {},
    42
  ]) {
    assert.equal(policy.isAllowedExternalUrl(url), false, String(url))
  }
})

test('IPC accepts only the live owner main frame and an empty argument list', () => {
  const valid = {
    ownerAlive: true,
    senderMatches: true,
    mainFrameMatches: true,
    senderUrl: rendererUrl,
    rendererUrl,
    args: []
  }
  assert.equal(policy.isAllowedAppInfoRequest(valid), true)
  for (const patch of [
    { ownerAlive: false },
    { senderMatches: false },
    { mainFrameMatches: false },
    { senderUrl: '' },
    { senderUrl: 'https://mail.google.com/' },
    { args: [undefined] },
    { args: [{ command: 'anything' }] }
  ]) {
    assert.equal(policy.isAllowedAppInfoRequest({ ...valid, ...patch }), false)
  }
})
