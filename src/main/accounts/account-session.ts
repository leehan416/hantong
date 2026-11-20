import { session, type Session } from 'electron'
import { isAccountId } from './account-state'

export function getAccountSession(accountId: string): Session {
  if (!isAccountId(accountId)) throw new Error('Invalid account data')
  return session.fromPartition(`persist:hantong-gmail-${accountId}`)
}
