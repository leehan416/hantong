import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import type { AccountState } from '../shared/accounts'
import {
  activateGmailAccount,
  addGmailAccount,
  parseAccountState,
  removeGmailAccount
} from './account-state'

interface AccountStore {
  getState: () => AccountState
  add: () => AccountState
  activate: (id: string) => AccountState
  remove: (id: string) => AccountState
}

export function createAccountStore(
  directory: string,
  createId: () => string = randomUUID
): AccountStore {
  const file = join(directory, 'accounts.json')

  function read(): AccountState {
    let content: string
    try {
      content = readFileSync(file, 'utf8')
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return { version: 1, accounts: [], activeAccountId: null }
      }
      throw new Error('Unable to load account data', { cause: error })
    }
    try {
      const value: unknown = JSON.parse(content)
      return parseAccountState(value)
    } catch {
      // Never reset a malformed or future-version file and silently lose accounts.
      throw new Error('Unable to load account data')
    }
  }

  let state = read()

  function save(next: AccountState): AccountState {
    const temporary = join(directory, `.accounts-${randomUUID()}.tmp`)
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      renameSync(temporary, file)
    } catch {
      const failure = new Error('Unable to save account data')
      // Only this operation's temporary file is removed; the saved file is preserved.
      try {
        rmSync(temporary, { force: true })
      } catch {
        throw failure
      }
      throw failure
    }
    state = next
    return parseAccountState(state)
  }

  return {
    getState: () => parseAccountState(state),
    add: () => save(addGmailAccount(state, createId())),
    activate: (id) => save(activateGmailAccount(state, id)),
    remove: (id) => save(removeGmailAccount(state, id))
  }
}
