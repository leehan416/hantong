import { isAccountId } from './account-state'
import { GmailMetadataFailure, type GmailHistoryPage } from './gmail-metadata'
import type { GmailSyncStore } from './gmail-sync-store'

export type GmailHistorySyncFailureCode =
  'invalid_account' | 'cancelled' | 'invalid_history' | 'unavailable'

export class GmailHistorySyncFailure extends Error {
  constructor(readonly code: GmailHistorySyncFailureCode) {
    super(`Gmail history sync ${code.replaceAll('_', ' ')}`)
    this.name = 'GmailHistorySyncFailure'
  }
}

export interface GmailHistorySyncResult {
  readonly kind: 'baseline' | 'changes'
  readonly historyId: string
  readonly addedMessageIds: readonly string[]
}

export interface GmailHistorySyncDependencies {
  readonly store: GmailSyncStore
  readonly accountExists: (accountId: string) => boolean
  readonly readHistoryId: (accountId: string, signal: AbortSignal) => Promise<string>
  readonly readHistoryPage: (
    accountId: string,
    startHistoryId: string,
    pageToken: string | undefined,
    signal: AbortSignal
  ) => Promise<GmailHistoryPage>
}

interface Operation {
  readonly controller: AbortController
  promise: Promise<GmailHistorySyncResult | null>
}

function isHistoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

function isMessageId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\r\n]/.test(value)
}

function compareHistoryIds(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left === right ? 0 : left < right ? -1 : 1
}

function validateAccountId(accountId: unknown): asserts accountId is string {
  if (!isAccountId(accountId)) throw new GmailHistorySyncFailure('invalid_account')
}

export function createGmailHistorySync(dependencies: GmailHistorySyncDependencies): {
  sync(accountId: string): Promise<GmailHistorySyncResult | null>
  cancel(accountId: string): void
  reset(accountId: string): void
} {
  const operations = new Map<string, Operation>()

  function assertCurrent(accountId: string, operation: Operation): void {
    if (operations.get(accountId) !== operation || operation.controller.signal.aborted) {
      throw new GmailHistorySyncFailure('cancelled')
    }
    try {
      if (!dependencies.accountExists(accountId))
        throw new GmailHistorySyncFailure('invalid_account')
    } catch (error) {
      if (error instanceof GmailHistorySyncFailure) throw error
      throw new GmailHistorySyncFailure('unavailable')
    }
  }

  function currentFailure(accountId: string, operation: Operation): GmailHistorySyncFailure | null {
    if (operations.get(accountId) !== operation || operation.controller.signal.aborted) {
      return new GmailHistorySyncFailure('cancelled')
    }
    try {
      if (!dependencies.accountExists(accountId))
        return new GmailHistorySyncFailure('invalid_account')
    } catch {
      return new GmailHistorySyncFailure('unavailable')
    }
    return null
  }

  async function baseline(
    accountId: string,
    operation: Operation
  ): Promise<GmailHistorySyncResult> {
    let historyId: string
    try {
      historyId = await dependencies.readHistoryId(accountId, operation.controller.signal)
    } catch (error) {
      const staleFailure = currentFailure(accountId, operation)
      if (staleFailure) throw staleFailure
      if (error instanceof GmailMetadataFailure) throw error
      throw new GmailHistorySyncFailure('unavailable')
    }
    assertCurrent(accountId, operation)
    if (!isHistoryId(historyId)) throw new GmailHistorySyncFailure('invalid_history')
    try {
      dependencies.store.write(accountId, historyId)
    } catch {
      throw new GmailHistorySyncFailure('unavailable')
    }
    assertCurrent(accountId, operation)
    return { kind: 'baseline', historyId, addedMessageIds: [] }
  }

  async function execute(accountId: string, operation: Operation): Promise<GmailHistorySyncResult> {
    assertCurrent(accountId, operation)
    let savedCursor: string | null
    try {
      savedCursor = dependencies.store.read(accountId)
    } catch {
      throw new GmailHistorySyncFailure('unavailable')
    }
    assertCurrent(accountId, operation)
    if (savedCursor === null) return baseline(accountId, operation)
    if (!isHistoryId(savedCursor)) throw new GmailHistorySyncFailure('invalid_history')

    const startHistoryId = savedCursor
    let previousHistoryId = savedCursor
    let pageToken: string | undefined
    const seenTokens = new Set<string>()
    const addedMessageIds: string[] = []
    const seenIds = new Set<string>()
    let finalHistoryId: string
    let pagesRead = 0

    try {
      while (true) {
        assertCurrent(accountId, operation)
        const page: unknown = await dependencies.readHistoryPage(
          accountId,
          startHistoryId,
          pageToken,
          operation.controller.signal
        )
        assertCurrent(accountId, operation)
        if (
          typeof page !== 'object' ||
          page === null ||
          Array.isArray(page) ||
          !('historyId' in page) ||
          !isHistoryId(page.historyId) ||
          compareHistoryIds(page.historyId, previousHistoryId) < 0 ||
          !('addedMessageIds' in page) ||
          !Array.isArray(page.addedMessageIds)
        ) {
          throw new GmailHistorySyncFailure('invalid_history')
        }
        const nextPageToken: unknown = 'nextPageToken' in page ? page.nextPageToken : undefined
        if (
          nextPageToken !== undefined &&
          (typeof nextPageToken !== 'string' ||
            nextPageToken.trim().length === 0 ||
            /[\r\n]/.test(nextPageToken))
        ) {
          throw new GmailHistorySyncFailure('invalid_history')
        }
        pagesRead += 1
        previousHistoryId = page.historyId
        finalHistoryId = page.historyId
        for (const id of page.addedMessageIds) {
          if (!isMessageId(id)) throw new GmailHistorySyncFailure('invalid_history')
          if (!seenIds.has(id)) {
            seenIds.add(id)
            addedMessageIds.push(id)
          }
        }
        if (nextPageToken === undefined) break
        // Stop before an unbounded provider page chain can advance the saved watermark.
        if (seenTokens.has(nextPageToken) || pagesRead >= 100) {
          throw new GmailHistorySyncFailure('invalid_history')
        }
        seenTokens.add(nextPageToken)
        pageToken = nextPageToken
      }
    } catch (error) {
      const staleFailure = currentFailure(accountId, operation)
      if (staleFailure) throw staleFailure
      if (error instanceof GmailMetadataFailure && error.code === 'history_expired') {
        return baseline(accountId, operation)
      }
      if (error instanceof GmailMetadataFailure || error instanceof GmailHistorySyncFailure)
        throw error
      throw new GmailHistorySyncFailure('unavailable')
    }

    assertCurrent(accountId, operation)
    if (compareHistoryIds(finalHistoryId, savedCursor) > 0) {
      try {
        dependencies.store.write(accountId, finalHistoryId)
      } catch {
        throw new GmailHistorySyncFailure('unavailable')
      }
    }
    assertCurrent(accountId, operation)
    return {
      kind: 'changes',
      historyId: finalHistoryId,
      addedMessageIds: finalHistoryId === savedCursor ? [] : addedMessageIds
    }
  }

  function sync(accountId: string): Promise<GmailHistorySyncResult | null> {
    try {
      validateAccountId(accountId)
    } catch (error) {
      return Promise.reject(error)
    }
    let exists: boolean
    try {
      exists = dependencies.accountExists(accountId)
    } catch {
      return Promise.reject(new GmailHistorySyncFailure('unavailable'))
    }
    if (!exists) return Promise.reject(new GmailHistorySyncFailure('invalid_account'))
    const existing = operations.get(accountId)
    if (existing) return existing.promise.then(() => null)

    const operation: Operation = {
      controller: new AbortController(),
      promise: Promise.resolve(null)
    }
    operations.set(accountId, operation)
    operation.promise = Promise.resolve()
      .then(() => execute(accountId, operation))
      .catch((error: unknown) => {
        const staleFailure = currentFailure(accountId, operation)
        if (staleFailure) throw staleFailure
        if (error instanceof GmailMetadataFailure || error instanceof GmailHistorySyncFailure)
          throw error
        throw new GmailHistorySyncFailure('unavailable')
      })
      .finally(() => {
        if (operations.get(accountId) === operation) operations.delete(accountId)
      })
    return operation.promise
  }

  function cancel(accountId: string): void {
    validateAccountId(accountId)
    const operation = operations.get(accountId)
    if (!operation) return
    operations.delete(accountId)
    operation.controller.abort()
  }

  function reset(accountId: string): void {
    validateAccountId(accountId)
    cancel(accountId)
    try {
      dependencies.store.delete(accountId)
    } catch {
      throw new GmailHistorySyncFailure('unavailable')
    }
  }

  return { sync, cancel, reset }
}
