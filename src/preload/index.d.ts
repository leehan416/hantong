import type { HantongApi } from '../shared/ipc'

declare global {
  interface Window {
    api: HantongApi
  }
}
