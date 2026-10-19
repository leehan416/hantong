import { resolve } from 'path'
import { defineConfig, loadEnv } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Finder/Dock launches pass no shell env and packages exclude .env, so packaged Main falls back to
// these build-time values. Main bundle only: a Desktop OAuth client cannot keep its secret anyway.
const BUNDLED_KEYS = [
  'HANTONG_GOOGLE_CLIENT_ID',
  'HANTONG_GOOGLE_CLIENT_SECRET',
  'HANTONG_RELAY_URL',
  'HANTONG_GMAIL_TOPIC'
]

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'HANTONG_')
  const bundled = Object.fromEntries(
    BUNDLED_KEYS.filter((key) => env[key]).map((key) => [key, env[key]])
  )
  return {
    main: {
      define: { __HANTONG_BUNDLED_ENV__: JSON.stringify(bundled) }
    },
    preload: {},
    renderer: {
      resolve: {
        alias: {
          '@renderer': resolve('src/renderer/src')
        }
      },
      plugins: [react()]
    }
  }
})
