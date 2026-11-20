/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test helper as JavaScript without a TypeScript loader. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

// Test-only loader: execute the checked-in source without adding a TS runtime dependency.
export function loadTypeScript(fileUrl, overrides = {}) {
  const require = createRequire(fileUrl)
  const module = { exports: {} }
  const source = readFileSync(fileUrl, 'utf8')
  const isTsx = fileUrl.pathname.endsWith('.tsx')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      ...(isTsx ? { jsx: ts.JsxEmit.ReactJSX } : {})
    }
  })
  runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
    URL,
    crypto: globalThis.crypto,
    AbortController,
    TextDecoder,
    TextEncoder,
    process: overrides.process ?? process,
    window: overrides.window,
    document: overrides.document ?? {
      activeElement: null,
      body: {},
      querySelectorAll: () => []
    },
    HTMLElement: overrides.HTMLElement ?? class HTMLElement {},
    Image:
      overrides.Image ??
      class Image {
        set src(value) {
          this.value = value
        }
        decode() {
          return Promise.resolve()
        }
      },
    Uint8Array,
    Response: overrides.Response,
    Request: overrides.Request,
    Headers: overrides.Headers,
    setTimeout: overrides.setTimeout ?? setTimeout,
    clearTimeout: overrides.clearTimeout ?? clearTimeout,
    setInterval,
    clearInterval,
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) {
        const jsonUrl = new URL(name, fileUrl)
        if (jsonUrl.pathname.endsWith('.json'))
          return { default: JSON.parse(readFileSync(jsonUrl, 'utf8')) }
        const tsUrl = new URL(`${name}.ts`, fileUrl)
        const tsxUrl = new URL(`${name}.tsx`, fileUrl)
        let sourceUrl
        try {
          readFileSync(tsUrl, 'utf8')
          sourceUrl = tsUrl
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          readFileSync(tsxUrl, 'utf8')
          sourceUrl = tsxUrl
        }
        return loadTypeScript(sourceUrl, overrides)
      }
      return require(name)
    }
  })
  return module.exports
}
