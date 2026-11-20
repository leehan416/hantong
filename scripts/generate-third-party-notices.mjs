#!/usr/bin/env node
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const packageRecords = lock.packages
const roots = [
  ...Object.keys(manifest.dependencies ?? {}),
  // React is a devDependency because Vite builds it into the shipped renderer.
  'react',
  'react-dom'
]

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Returns a lockfile key or undefined.
function resolvePackageKey(parentKey, name) {
  let directory = parentKey
  while (directory) {
    const candidate = path.posix.join(directory, 'node_modules', name)
    if (packageRecords[candidate]) return candidate
    directory = path.posix.dirname(directory)
    if (directory === '.') directory = ''
  }
  const rootCandidate = path.posix.join('node_modules', name)
  return packageRecords[rootCandidate] ? rootCandidate : undefined
}

const packages = new Map()
const pending = roots.map((name) => ({ name, parentKey: '' }))
while (pending.length) {
  const { name, parentKey } = pending.pop()
  const key = parentKey ? resolvePackageKey(parentKey, name) : `node_modules/${name}`
  if (!key || !packageRecords[key]) {
    throw new Error(`Could not resolve shipped dependency ${name} from ${parentKey || 'the app'}`)
  }
  const record = packageRecords[key]
  const identity = `${record.name ?? name}@${record.version}`
  if (packages.has(identity)) continue
  const packageDirectory = path.join(root, key)
  const installed = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
  if (installed.version !== record.version) {
    throw new Error(`${key}: installed ${installed.version}, lockfile ${record.version}`)
  }
  packages.set(identity, { key, record, installed, packageDirectory })
  for (const dependency of Object.keys(record.dependencies ?? {})) {
    pending.push({ name: dependency, parentKey: key })
  }
  for (const dependency of Object.keys(record.optionalDependencies ?? {})) {
    pending.push({ name: dependency, parentKey: key })
  }
}

const sections = []
const fence = String.fromCharCode(96).repeat(3)
for (const [identity, item] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const entries = await readdir(item.packageDirectory, { withFileTypes: true })
  const licenseFiles = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        !/\.d\.ts$/i.test(entry.name) &&
        /^(license|licence|copying|notice)(?:[._-].*)?$/i.test(entry.name)
    )
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  if (!licenseFiles.length) {
    if (item.installed.license === 'MIT' && item.installed.repository?.url) {
      const repository = item.installed.repository.url.replace(/^git\+/, '').replace(/\.git$/, '')
      sections.push(`## ${identity} (MIT)

The installed package metadata declares MIT, but the package does not include a top-level license file.

Package metadata: [${identity}](https://www.npmjs.com/package/${item.installed.name}/v/${item.installed.version})

Upstream repository: [${repository}](${repository})

Standard MIT permission and warranty terms, from [SPDX MIT](https://spdx.org/licenses/MIT.html). These are standard terms, not a copyright notice supplied by the package:

${fence}
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
${fence}`)
      continue
    }
    if (
      item.installed.name === '@ai-sdk/provider-utils' &&
      item.installed.license === 'Apache-2.0' &&
      item.installed.repository?.url === 'https://github.com/vercel/ai' &&
      item.installed.repository?.directory === 'packages/provider-utils'
    ) {
      const upstreamLicensePath = 'node_modules/@ai-sdk/openai-compatible/LICENSE'
      const upstreamLicense = (await readFile(path.join(root, upstreamLicensePath), 'utf8')).trim()
      sections.push(`## ${identity} (Apache-2.0)

The locked package metadata declares Apache-2.0 and identifies the upstream package directory. Its published file list omits the repository-root license. The same repository license is included with the installed OpenAI-compatible package.

Package metadata: [${identity}](https://www.npmjs.com/package/@ai-sdk/provider-utils/v/${item.installed.version})

Upstream repository license: [vercel/ai LICENSE](https://github.com/vercel/ai/blob/main/LICENSE)

Source: \`${upstreamLicensePath}\`

\`\`\`
${upstreamLicense}
\`\`\``)
      continue
    }
    if (
      item.installed.name === 'lazy-val' &&
      item.installed.version === '1.0.5' &&
      item.installed.license === 'MIT' &&
      item.installed.author === 'Vladimir Krivosheev'
    ) {
      sections.push(`## lazy-val 1.0.5 (MIT)

The installed package metadata attributes this package to Vladimir Krivosheev and declares the MIT license. The published package declares MIT but does not include a license file.

Package metadata: [lazy-val package.json](https://github.com/develar/lazy-val/blob/master/package.json)

Standard MIT permission and warranty terms, from [SPDX MIT](https://spdx.org/licenses/MIT.html). These are standard terms, not a copyright notice supplied by the package:

${fence}
MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
${fence}`)
      continue
    }
    throw new Error(
      `${identity} (${item.key}) has no top-level LICENSE, LICENCE, COPYING, or NOTICE file`
    )
  }
  for (const file of licenseFiles) {
    const text = (await readFile(path.join(item.packageDirectory, file), 'utf8')).trim()
    if (!text) throw new Error(`${identity}/${file} is empty`)
    sections.push(
      `## ${identity} (${item.installed.license ?? item.record.license ?? 'license in file'})\n\nSource: \`${item.key}/${file}\`\n\n\`\`\`\n${text}\n\`\`\``
    )
  }
}

sections.push(`## OpenAI Codex CLI 0.167.1 (Apache-2.0)

The Apple Silicon runtime is provisioned from the official OpenAI release at
<https://github.com/openai/codex/releases/tag/rust-v0.167.1>. The release's
Apache License 2.0 is included at \`resources/codex-runtime/LICENSE\` and shipped
inside the application. The runtime binary is downloaded and verified during
\`npm run provision:codex-runtime\`; archive and executable SHA-256 pins are
recorded in \`scripts/provision-codex-runtime.mjs\` and
\`src/main/codex-runtime-pin.ts\`.`)

const header = `# Third-Party Notices

Hantong ships the following third-party software. Electron and Chromium notices are
shipped alongside the app as \`LICENSE.electron.txt\` and \`LICENSES.chromium.html\`.

`
const generated = header + sections.join('\n\n') + '\n'
await writeFile(
  path.join(root, 'THIRD_PARTY_NOTICES.md'),
  generated.replace(/\r\n?/g, '\n').replace(/[ \t]+(?=\n|$)/g, '')
)
console.log(`Wrote notices for ${packages.size} packages (${sections.length} license files).`)
