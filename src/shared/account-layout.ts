import {
  ACCOUNT_CHROME_HEIGHT,
  ACCOUNT_STATUS_STRIP_HEIGHT,
  ACCOUNT_SIDEBAR_COLLAPSED_WIDTH,
  ACCOUNT_SIDEBAR_WIDTH,
  AI_MAIL_PANEL_WIDTH
} from './ipc'
import type { AccountSelectorPosition } from './settings'

export interface AccountLayoutInput {
  width: number
  height: number
  position: AccountSelectorPosition
  sidebarCollapsed?: boolean
  statusStripVisible?: boolean
  aiMailPanelOpen?: boolean
}

export interface AccountViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export function isAccountSidebarCollapsedForPanel(
  position: AccountSelectorPosition,
  sidebarCollapsed: boolean,
  aiMailPanelOpen: boolean
): boolean {
  return sidebarCollapsed || (aiMailPanelOpen && (position === 'left' || position === 'right'))
}

export function getAiMailPanelWidth(
  width: number,
  position: AccountSelectorPosition,
  sidebarCollapsed: boolean,
  open: boolean
): number {
  if (!open) return 0
  const safeWidth = Math.max(0, Math.floor(width))
  const sidebarWidth =
    position === 'left' || position === 'right'
      ? isAccountSidebarCollapsedForPanel(position, sidebarCollapsed, open)
        ? ACCOUNT_SIDEBAR_COLLAPSED_WIDTH
        : ACCOUNT_SIDEBAR_WIDTH
      : 0
  const contentWidth = Math.max(0, safeWidth - sidebarWidth)
  return Math.min(AI_MAIL_PANEL_WIDTH, Math.max(0, contentWidth - 264))
}

export function getAccountViewBounds({
  width,
  height,
  position,
  sidebarCollapsed = false,
  statusStripVisible = true,
  aiMailPanelOpen = false
}: AccountLayoutInput): AccountViewBounds {
  const safeWidth = Math.max(0, Math.floor(width))
  const safeHeight = Math.max(0, Math.floor(height))
  const chromeHeight =
    ACCOUNT_CHROME_HEIGHT - (statusStripVisible ? 0 : ACCOUNT_STATUS_STRIP_HEIGHT)
  const statusHeight = statusStripVisible ? ACCOUNT_STATUS_STRIP_HEIGHT : 0
  const effectiveSidebarCollapsed = isAccountSidebarCollapsedForPanel(
    position,
    sidebarCollapsed,
    aiMailPanelOpen
  )
  const effectiveSidebarWidth = effectiveSidebarCollapsed
    ? ACCOUNT_SIDEBAR_COLLAPSED_WIDTH
    : ACCOUNT_SIDEBAR_WIDTH
  const panelWidth = getAiMailPanelWidth(width, position, sidebarCollapsed, aiMailPanelOpen)

  switch (position) {
    case 'bottom':
      return {
        x: 0,
        y: 0,
        width: Math.max(0, safeWidth - panelWidth),
        height: Math.max(0, safeHeight - chromeHeight)
      }
    case 'left':
      return {
        x: Math.min(safeWidth, effectiveSidebarWidth),
        y: Math.min(safeHeight, statusHeight),
        width: Math.max(0, safeWidth - effectiveSidebarWidth - panelWidth),
        height: Math.max(0, safeHeight - statusHeight)
      }
    case 'right':
      return {
        x: 0,
        y: Math.min(safeHeight, statusHeight),
        width: Math.max(0, safeWidth - effectiveSidebarWidth - panelWidth),
        height: Math.max(0, safeHeight - statusHeight)
      }
    case 'top':
    default:
      return {
        x: 0,
        y: Math.min(safeHeight, chromeHeight),
        width: Math.max(0, safeWidth - panelWidth),
        height: Math.max(0, safeHeight - chromeHeight)
      }
  }
}
