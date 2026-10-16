import { isAccountId } from './account-state'

export const GMAIL_ACCOUNT_IDENTITY_SCRIPT = `(() => {
  const emails = new Set();
  for (const anchor of document.querySelectorAll('header a[href], [role="banner"] a[href]')) {
    if (anchor.closest('main,[role="main"],[role="dialog"]')) continue;
    let target;
    try { target = new URL(anchor.href); } catch { continue; }
    if (target.protocol !== 'https:' || target.hostname !== 'accounts.google.com' ||
        target.port !== '' || target.username || target.password ||
        target.pathname !== '/SignOutOptions') continue;
    const label = anchor.getAttribute('aria-label');
    if (typeof label !== 'string' || label.length === 0 || label.length > 256) continue;
    const matches = [...label.matchAll(/(?:^|[\\s(<])([A-Z0-9.!#$%&'*+\\x2F=?^_\\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)(?=$|[\\s)>])/ig)].map((match) => match[1]);
    if (matches.length !== 1) continue;
    emails.add(matches[0].toLowerCase());
  }
  return emails.size === 1 ? [...emails][0] : null;
})()`

interface IdentityWebContents {
  getURL(): string
  isDestroyed(): boolean
  isLoadingMainFrame(): boolean
  executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string }>,
    userGesture?: boolean
  ): Promise<unknown>
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
  | 'script_failed'
  | 'navigation_changed'
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

function validEmailResult(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 320 &&
    /^[^\s@]+@[^\s@]+$/.test(value) &&
    !/[\r\n\0]/.test(value)
  )
}

export function createGoogleWebIdentityReader(
  getView: (accountId: string) => IdentityView | undefined,
  reportFailure?: (reason: GoogleWebIdentityFailureReason) => void
): {
  read(
    accountId: string,
    signal?: AbortSignal
  ): Promise<{ accountExists: true; emailAddress: string } | null>
} {
  const report = (reason: GoogleWebIdentityFailureReason): void => {
    try {
      reportFailure?.(reason)
    } catch {
      // Diagnostics must never affect identity verification.
    }
  }

  return {
    async read(accountId, signal) {
      if (!isAccountId(accountId) || signal?.aborted) return null
      const view = getView(accountId)
      if (!view) {
        report('missing_view')
        return null
      }
      if (!view.eligible()) {
        report(view.readinessFailure?.() ?? 'not_ready')
        return null
      }
      const { contents } = view
      if (contents.isDestroyed()) {
        report('document_destroyed')
        return null
      }
      if (contents.isLoadingMainFrame()) {
        report('document_loading')
        return null
      }
      if (!isAllowedGmailIdentityUrl(contents.getURL())) {
        report('untrusted_document')
        return null
      }
      const revision = view.revision()
      let value: unknown
      try {
        value = await contents.executeJavaScriptInIsolatedWorld(999, [
          { code: GMAIL_ACCOUNT_IDENTITY_SCRIPT }
        ])
      } catch {
        report('script_failed')
        return null
      }
      const latestView = getView(accountId)
      if (
        !latestView ||
        latestView.contents !== contents ||
        latestView.revision() !== revision ||
        !latestView.eligible() ||
        !view.eligible() ||
        contents.isDestroyed() ||
        contents.isLoadingMainFrame() ||
        view.revision() !== revision ||
        !isAllowedGmailIdentityUrl(contents.getURL())
      ) {
        if (!signal?.aborted) report('navigation_changed')
        return null
      }
      if (signal?.aborted) return null
      if (!validEmailResult(value)) {
        report('identity_unavailable')
        return null
      }
      return { accountExists: true, emailAddress: value }
    }
  }
}
