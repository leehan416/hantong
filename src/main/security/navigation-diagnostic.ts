export type NavigationDiagnosticSource =
  'redirect' | 'navigation' | 'popup' | 'external_open_failure'
export type NavigationDiagnosticContext = 'main' | 'popup'
export type NavigationDiagnosticReason =
  'external_redirect' | 'oauth_endpoint' | 'unsafe_url' | 'mail_access_denied'

export interface NavigationDiagnostic {
  readonly source: NavigationDiagnosticSource
  readonly context: NavigationDiagnosticContext
  readonly hostname: string
  readonly route: 'google_signin' | 'google_oauth' | 'gmail' | 'other'
  readonly reason: NavigationDiagnosticReason
}

export function sanitizeNavigationDiagnostic(
  source: unknown,
  context: unknown,
  value: unknown,
  reason: unknown,
  // Popup and window-open targets are usually links inside mail, so only Google hosts are kept;
  // sign-in redirects keep their host so a blocked school SSO step stays diagnosable.
  revealHost = source !== 'popup'
): NavigationDiagnostic {
  const safeSource: NavigationDiagnosticSource =
    source === 'redirect' ||
    source === 'navigation' ||
    source === 'popup' ||
    source === 'external_open_failure'
      ? source
      : 'navigation'
  const safeContext: NavigationDiagnosticContext = context === 'popup' ? 'popup' : 'main'
  const safeReason: NavigationDiagnosticReason =
    reason === 'external_redirect' || reason === 'oauth_endpoint' || reason === 'mail_access_denied'
      ? reason
      : 'unsafe_url'
  let hostname = 'redacted'
  let route: NavigationDiagnostic['route'] = 'other'
  if (typeof value === 'string') {
    try {
      const url = new URL(value)
      const candidate = url.hostname.toLowerCase()
      const validHost =
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        candidate.length <= 253 &&
        candidate
          .split('.')
          .every(
            (label) =>
              label.length > 0 &&
              label.length <= 63 &&
              /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
          ) &&
        !candidate.includes('@')
      const googleHost =
        candidate.endsWith('.google.com') ||
        candidate === 'accounts.youtube.com' ||
        /^accounts\.google\.[a-z.]+$/.test(candidate)
      if (validHost && (revealHost || googleHost)) {
        hostname = candidate
        if (candidate === 'accounts.google.com' && /^\/o\/oauth2(?:\/|$)/.test(url.pathname))
          route = 'google_oauth'
        else if (
          candidate === 'accounts.google.com' &&
          /^\/(?:v\d+\/)?signin(?:\/|$)/.test(url.pathname)
        )
          route = 'google_signin'
        else if (candidate === 'mail.google.com' && /^\/mail(?:\/|$)/.test(url.pathname))
          route = 'gmail'
      }
    } catch {
      // Keep malformed destinations redacted.
    }
  }
  return { source: safeSource, context: safeContext, hostname, route, reason: safeReason }
}
