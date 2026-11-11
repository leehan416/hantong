import { isAccountId, isValidGmailAccountDisplayName } from './account-state'
import { isAccountColor } from '../shared/accounts'
import { isSettingsPatch } from './settings-store'

interface AppInfoRequest {
  ownerAlive: boolean
  senderMatches: boolean
  mainFrameMatches: boolean
  senderUrl: string
  rendererUrl: string
  args: unknown[]
}

interface AccountRequest extends Omit<AppInfoRequest, 'args'> {
  operation: unknown
  args: unknown[]
  accountExists: boolean
}

interface SettingsRequest extends Omit<AppInfoRequest, 'args'> {
  operation: unknown
  args: unknown[]
}

interface GoogleConnectionRequest extends Omit<AppInfoRequest, 'args'> {
  operation: unknown
  args: unknown[]
  accountExists: boolean
}

interface NotificationRequest extends Omit<AppInfoRequest, 'args'> {
  operation: unknown
  args: unknown[]
  accountExists: boolean
}

interface AiMailCodexRequest extends Omit<AppInfoRequest, 'args'> {
  operation: 'status' | 'connect' | 'disconnect' | 'generate' | 'cancel'
  args: unknown[]
}

const isBoundedId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)

export function isAllowedAiMailCodexRequest(request: AiMailCodexRequest): boolean {
  if (
    !request.ownerAlive ||
    !request.senderMatches ||
    !request.mainFrameMatches ||
    !isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  ) {
    return false
  }
  if (
    request.operation === 'status' ||
    request.operation === 'connect' ||
    request.operation === 'disconnect'
  ) {
    return request.args.length === 0
  }
  if (request.operation === 'cancel')
    return request.args.length === 1 && isBoundedId(request.args[0])
  if (request.args.length !== 1 || !request.args[0] || typeof request.args[0] !== 'object')
    return false
  const value = request.args[0] as Record<string, unknown>
  return (
    isBoundedId(value.accountId) &&
    isBoundedId(value.composeId) &&
    isBoundedId(value.requestId) &&
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    typeof value.prompt === 'string' &&
    value.prompt.length > 0 &&
    value.prompt.length <= 4000 &&
    (value.followUp === undefined ||
      (typeof value.followUp === 'string' && value.followUp.length <= 2000)) &&
    Object.keys(value).every((key) =>
      ['accountId', 'composeId', 'requestId', 'generation', 'prompt', 'followUp'].includes(key)
    )
  )
}

export function isAllowedAiMailComposeTargetRequest(request: AppInfoRequest): boolean {
  return (
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    request.args.length === 0 &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  )
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

export function isAllowedLoginLaunchRequest(
  request: AppInfoRequest,
  operation: 'get' | 'set'
): boolean {
  return (
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl) &&
    (operation === 'get'
      ? request.args.length === 0
      : request.args.length === 1 && typeof request.args[0] === 'boolean')
  )
}

export function isAllowedAccountRequest(request: AccountRequest): boolean {
  const common =
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  if (!common) return false
  if (request.operation === 'get' || request.operation === 'add') return request.args.length === 0
  if (request.operation === 'retry') {
    return request.args.length === 0 && request.accountExists
  }
  if (request.operation === 'setDisplayName') {
    return (
      request.args.length === 2 &&
      isAccountId(request.args[0]) &&
      isValidGmailAccountDisplayName(request.args[1]) &&
      request.accountExists
    )
  }
  if (request.operation === 'move') {
    return (
      request.args.length === 2 &&
      isAccountId(request.args[0]) &&
      Number.isInteger(request.args[1]) &&
      request.accountExists
    )
  }
  if (request.operation === 'setColor') {
    return (
      request.args.length === 2 &&
      isAccountId(request.args[0]) &&
      isAccountColor(request.args[1]) &&
      request.accountExists
    )
  }
  if (request.operation === 'setNotificationsEnabled') {
    return (
      request.args.length === 2 &&
      isAccountId(request.args[0]) &&
      typeof request.args[1] === 'boolean' &&
      request.accountExists
    )
  }
  return (
    (request.operation === 'activate' || request.operation === 'remove') &&
    request.args.length === 1 &&
    isAccountId(request.args[0]) &&
    request.accountExists
  )
}

export function isAllowedGoogleConnectionRequest(request: GoogleConnectionRequest): boolean {
  return (
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl) &&
    request.accountExists &&
    typeof request.operation === 'string' &&
    ['get', 'connect', 'cancel', 'disconnect'].includes(request.operation) &&
    request.args.length === 1 &&
    isAccountId(request.args[0])
  )
}

export function isAllowedNotificationRequest(request: NotificationRequest): boolean {
  const common =
    request.ownerAlive &&
    request.senderMatches &&
    request.mainFrameMatches &&
    isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  if (!common) return false
  if (request.operation === 'get') return request.args.length === 0
  return (
    typeof request.operation === 'string' &&
    ['recover', 'cancel', 'retry'].includes(request.operation) &&
    request.args.length === 1 &&
    isAccountId(request.args[0]) &&
    request.accountExists
  )
}

export function isAllowedSettingsRequest(request: SettingsRequest): boolean {
  if (
    !request.ownerAlive ||
    !request.senderMatches ||
    !request.mainFrameMatches ||
    !isTrustedRendererUrl(request.senderUrl, request.rendererUrl)
  ) {
    return false
  }
  if (request.operation === 'get') return request.args.length === 0
  if (request.operation === 'panel') {
    return request.args.length === 1 && typeof request.args[0] === 'boolean'
  }
  if (request.operation === 'status-strip') {
    return request.args.length === 1 && typeof request.args[0] === 'boolean'
  }
  return (
    request.operation === 'update' && request.args.length === 1 && isSettingsPatch(request.args[0])
  )
}
