import { isAccountId, isValidEmail } from './account-state'

// Gmail titles end with "<view> - <account email> - <product>" for every account domain.
// Only that fixed position is trusted: scanning further left could pick an address from a subject.
export function emailFromGmailTitle(title: string): string | null {
  const segment = title.split(' - ').at(-2)?.trim()
  return segment && isValidEmail(segment) ? segment.toLowerCase() : null
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
