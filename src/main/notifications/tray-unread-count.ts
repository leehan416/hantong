export function updateTrayUnreadCount(
  total: number,
  platform: NodeJS.Platform,
  setTitle: (title: string) => void
): void {
  if (platform !== 'darwin') return
  setTitle(total > 0 ? String(total) : '')
}
