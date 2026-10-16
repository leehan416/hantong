interface AppInfoRequest {
  ownerAlive: boolean
  senderMatches: boolean
  mainFrameMatches: boolean
  senderUrl: string
  rendererUrl: string
  args: unknown[]
}

export function isTrustedRendererUrl(candidate: string, rendererUrl: string): boolean {
  try {
    const actual = new URL(candidate)
    const expected = new URL(rendererUrl)
    if (actual.username || actual.password) return false
    actual.hash = ''
    expected.hash = ''
    return actual.href === expected.href
  } catch {
    // Unparseable input is untrusted; it must never reach a privileged operation.
    return false
  }
}

export function isAllowedExternalUrl(value: unknown): boolean {
  if (
    typeof value !== 'string' ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    )
  ) {
    return false
  }
  try {
    const url = new URL(value)
    if (url.username || url.password) return false
    return (
      (url.protocol === 'https:' && url.hostname !== '') ||
      (url.protocol === 'mailto:' && url.host === '' && url.pathname !== '')
    )
  } catch {
    return false
  }
}

export function isAllowedAppInfoRequest(request: AppInfoRequest): boolean {
  return (
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    request.args.length === 0 &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  )
}
