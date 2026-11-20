import { builtinModules } from 'node:module'
import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'

const builtinImportPatterns = builtinModules.flatMap((builtin) => {
  const name = builtin.replace(/^node:/, '')
  return [name, `${name}/*`, `node:${name}`, `node:${name}/*`]
})

const mainImportPatterns = [
  '../../main/**',
  '../../../main/**',
  '../../../../main/**',
  '../../../../../main/**',
  '../../../../../../main/**',
  '~/main/**'
]

const rendererImportRestrictions = [
  {
    group: ['electron', 'electron/*', ...builtinImportPatterns],
    message: 'Renderer code must not import Electron or Node built-ins.'
  },
  {
    group: mainImportPatterns,
    message: 'Renderer code must not import Main.'
  },
  {
    group: ['~/preload/**'],
    allowTypeImports: true,
    message: 'Renderer runtime code must not import Preload.'
  }
]

const componentImportRestrictions = [
  ...rendererImportRestrictions,
  {
    group: [
      '../shell/**',
      '../../shell/**',
      '../../../shell/**',
      '../../../../shell/**',
      '~/renderer/src/shell/**'
    ],
    message: 'Renderer components and API modules must not import shell.'
  }
]

export default defineConfig(
  { ignores: ['**/node_modules', '**/dist', '**/out', '.claude'] },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: rendererImportRestrictions }]
    }
  },
  {
    files: ['src/renderer/src/components/**/*.{ts,tsx}', 'src/renderer/src/api/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: componentImportRestrictions }]
    }
  },
  eslintConfigPrettier
)
