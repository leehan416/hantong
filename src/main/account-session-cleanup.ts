import type { Session } from 'electron'
import { getAccountSession } from './account-session'

type AccountSessionCleanupApi = Pick<
  Session,
  'closeAllConnections' | 'clearStorageData' | 'clearCache' | 'clearAuthCache'
>

export function createAccountSessionCleaner(
  getSession: (accountId: string) => AccountSessionCleanupApi
): (accountId: string) => Promise<void> {
  return async (accountId): Promise<void> => {
    const accountSession = getSession(accountId)
    await accountSession.closeAllConnections()
    await accountSession.clearStorageData()
    await accountSession.clearCache()
    await accountSession.clearAuthCache()
  }
}

export const clearAccountSession = createAccountSessionCleaner(getAccountSession)
