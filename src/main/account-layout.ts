import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH
} from '../shared/ipc'
import type { AccountSelectorPosition } from '../shared/settings'

export interface AccountLayoutInput {
  width: number
  height: number
  position: AccountSelectorPosition
  sidebarCollapsed?: boolean
}

export interface AccountViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export function getAccountViewBounds({
  width,
  height,
  position,
  sidebarCollapsed = false
}: AccountLayoutInput): AccountViewBounds {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeHeight = Math.max(0, Math.floor(height))
  const sidebarWidth = sidebarCollapsed ? ACCOUNT_SIDEBAR_COLLAPSED_WIDTH : ACCOUNT_SIDEBAR_WIDTH

  switch (position) {
    case 'bottom':
      return {
        x: 0,
        y: 0,
        width: safeWidth,
        height: Math.max(0, safeHeight - ACCOUNT_CHROME_HEIGHT)
      }
    case 'left':
      return {
        x: Math.min(safeWidth, sidebarWidth),
        y: Math.min(safeHeight, 32),
        width: Math.max(0, safeWidth - sidebarWidth),
        height: Math.max(0, safeHeight - 32)
      }
    case 'right':
      return {
        x: 0,
        y: Math.min(safeHeight, 32),
        width: Math.max(0, safeWidth - sidebarWidth),
        height: Math.max(0, safeHeight - 32)
      }
    case 'top':
    default:
      return {
        x: 0,
        y: Math.min(safeHeight, ACCOUNT_CHROME_HEIGHT),
        width: safeWidth,
        height: Math.max(0, safeHeight - ACCOUNT_CHROME_HEIGHT)
      }
  }
}
