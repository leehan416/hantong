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
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  })
  runInNewContext(compiled.outputText, {
    exports: module.exports,
    module,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    require(name) {
      if (Object.hasOwn(overrides, name)) return overrides[name]
      if (name.startsWith('.')) {
        return loadTypeScript(new URL(`${name}.ts`, fileUrl), overrides)
      }
      return require(name)
    }
  })
  return module.exports
}
