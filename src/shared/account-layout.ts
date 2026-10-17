import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_STATUS_STRIP_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH
} from './ipc'
import type { AccountSelectorPosition } from './settings'

export interface AccountLayoutInput {
  width: number
  height: number
  position: AccountSelectorPosition
  sidebarCollapsed?: boolean
  statusStripVisible?: boolean
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
  sidebarCollapsed = false,
  statusStripVisible = true
}: AccountLayoutInput): AccountViewBounds {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeHeight = Math.max(0, Math.floor(height))
  const sidebarWidth = sidebarCollapsed ? ACCOUNT_SIDEBAR_COLLAPSED_WIDTH : ACCOUNT_SIDEBAR_WIDTH
  const chromeHeight =
    ACCOUNT_CHROME_HEIGHT - (statusStripVisible ? 0 : ACCOUNT_STATUS_STRIP_HEIGHT)
  const statusHeight = statusStripVisible ? ACCOUNT_STATUS_STRIP_HEIGHT : 0

  switch (position) {
    case 'bottom':
      return {
        x: 0,
        y: 0,
        width: safeWidth,
        height: Math.max(0, safeHeight - chromeHeight)
      }
    case 'left':
      return {
        x: Math.min(safeWidth, sidebarWidth),
        y: Math.min(safeHeight, statusHeight),
        width: Math.max(0, safeWidth - sidebarWidth),
        height: Math.max(0, safeHeight - statusHeight)
      }
    case 'right':
      return {
        x: 0,
        y: Math.min(safeHeight, statusHeight),
        width: Math.max(0, safeWidth - sidebarWidth),
        height: Math.max(0, safeHeight - statusHeight)
      }
    case 'top':
    default:
      return {
        x: 0,
        y: Math.min(safeHeight, chromeHeight),
        width: safeWidth,
        height: Math.max(0, safeHeight - chromeHeight)
      }
  }
}
