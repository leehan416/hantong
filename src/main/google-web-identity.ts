import { isAccountId } from './account-state'

// Gmail titles end with "<view> - <account email> - <product>" for every account domain.
// The rightmost email-only segment is the signed-in account, so an address in a subject
// (always left of it) cannot replace it. Titles without that segment fail closed.
export function emailFromGmailTitle(title: string): string | null {
  const segments = title.split(' - ')
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    const segment = segments[index].trim()
    if (segment.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(segment))
      return segment.toLowerCase()
  }
  return null
}

interface IdentityWebContents {
  getURL(): string
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  getTitle(): string
}

interface IdentityView {
  readonly contents: IdentityWebContents
  readonly revision: () => number
  readonly eligible: () => boolean
  readonly readinessFailure?: () => GoogleWebIdentityFailureReason
}

export type GoogleWebIdentityFailureReason =
  | 'missing_view'
  | 'not_ready'
  | 'manager_disposed'
  | 'view_loading'
  | 'view_not_loaded'
  | 'view_blocked'
  | 'view_disposing'
  | 'document_destroyed'
  | 'document_loading'
  | 'untrusted_document'
  | 'identity_unavailable'

export function isAllowedGmailIdentityUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' &&
      url.hostname === 'mail.google.com' &&
      url.port === '' &&
      !url.username &&
      !url.password &&
      /^\/mail\/u\/\d+(?:\/|$)/.test(url.pathname)
    )
  } catch {
    return false
  }
}

export function createGoogleWebIdentityReader(
  getView: (accountId: string) => IdentityView | undefined,
  reportFailure?: (reason: GoogleWebIdentityFailureReason, accountId: string) => void
): {
  read(
    accountId: string,
    signal?: AbortSignal
  ): Promise<{ accountExists: true; emailAddress: string } | null>
} {
  const report = (reason: GoogleWebIdentityFailureReason, accountId: string): void => {
    try {
      reportFailure?.(reason, accountId)
    } catch {
      // Diagnostics must never affect identity verification.
    }
  }

  return {
    async read(accountId, signal) {
      if (!isAccountId(accountId) || signal?.aborted) return null
      const view = getView(accountId)
      if (!view) {
        report('missing_view', accountId)
        return null
      }
      if (!view.eligible()) {
        report(view.readinessFailure?.() ?? 'not_ready', accountId)
        return null
      }
      const { contents } = view
      if (contents.isDestroyed()) {
        report('document_destroyed', accountId)
        return null
      }
      if (contents.isLoadingMainFrame()) {
        report('document_loading', accountId)
        return null
      }
      if (!isAllowedGmailIdentityUrl(contents.getURL())) {
        report('untrusted_document', accountId)
        return null
      }
      const emailAddress = emailFromGmailTitle(contents.getTitle())
      if (!emailAddress) {
        report('identity_unavailable', accountId)
        return null
      }
      return { accountExists: true, emailAddress }
    }
  }
}
