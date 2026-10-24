export type GmailNavigation = 'internal' | 'external' | 'blocked'

export function classifyGmailNavigation(value: string): GmailNavigation {
  if (Array.from(value).some((character) => character.charCodeAt(0) <= 32)) return 'blocked'
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return 'blocked'
    if (url.hostname === 'accounts.google.com') {
      // API OAuth belongs in the system browser, separately from Gmail web login.
      if (decodeURIComponent(url.pathname).startsWith('/o/oauth2')) return 'blocked'
      return url.port === '' ? 'internal' : 'blocked'
    }
    if (
      url.hostname === 'mail.google.com' ||
      url.hostname === 'accounts.youtube.com' ||
      url.hostname === 'accounts.google.co.kr'
    )
      return url.port === '' ? 'internal' : 'blocked'
    return 'external'
  } catch {
    return 'blocked'
  }
}
