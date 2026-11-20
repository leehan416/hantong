const URL_PATTERN = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]+/gi
const BARE_HOST_PATTERN = /(?<![@\w])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s<>]*)?/gi
const IPV4_URL_PATTERN = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}(?:[/?#][^\s<>]*)?/g
const MARKDOWN_START_PATTERN = /\[([^\]]+)\]\(/g
const MARKDOWN_REFERENCE_PATTERN = /^(\s*\[[^\]]+\]:\s*)(<[^>]*>|\S+)(\s*)$/gim

const REDACTIONS: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
    '[PRIVATE KEY]'
  ],
  [/(?:비밀번호|패스워드)\s*[:：=]?\s*(?:"[^"]*"|'[^']*'|[^\s,;，；]+)/gi, '[PASSWORD]'],
  [/\b(?:password|passwd|passcode)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[PASSWORD]'],
  [
    /(?:인증번호|일회용\s*코드|복구\s*코드)\s*(?:는|은|가|이|를|을)?\s*[:：=]?\s*\d{4,10}(?!\d)/gi,
    '[AUTH CODE]'
  ],
  [
    /\b(?:otp|one[- ]time code|verification code|recovery code)\s*[:=]?\s*\d{4,10}(?!\d)/gi,
    '[AUTH CODE]'
  ],
  [/\b(?:cvc|cvv|security code)\s*[:=]?\s*\d{3,4}\b/gi, '[CVC]'],
  [/(?:계좌번호|계좌|은행\s*계좌)\s*[:：=#]?\s*\d[\d -]{5,22}\d/gi, '[ACCOUNT NUMBER]'],
  [
    /\b(?:account|routing|sort code)\s*(?:number|no\.?|#|:)?\s*[:=]?\s*\d[\d -]{5,22}\d\b/gi,
    '[ACCOUNT NUMBER]'
  ],
  [
    /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|session[_ -]?cookie)\s*[:=]\s*[^\s,;]+/gi,
    '[CREDENTIAL]'
  ],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, '[CREDENTIAL]'],
  [
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g,
    '[TOKEN]'
  ],
  [/\b\d{3,4}[- ]\d{4}[- ]\d{4}[- ]\d{4,7}\b/g, '[FINANCIAL ID]'],
  [/\b\d{6}-[1-4]\d{6}\b/g, '[IDENTITY NUMBER]'],
  [
    /\b(?:passport|driver'?s license|license number)\s*(?:no\.?|number)?\s*[:#]?\s*[A-Z0-9-]{5,16}\b/gi,
    '[IDENTITY NUMBER]'
  ],
  [/(?:이름|성명)\s*[:：=]?\s*[가-힣]{2,5}/g, '[NAME]'],
  [/(?:주소|거주지)\s*[:：=]?\s*[^\n,;，；]{3,80}/g, '[ADDRESS]'],
  [/(?:생년월일|생일)\s*[:：=]?\s*\d{4}[./년 -]\s*\d{1,2}[./월 -]\s*\d{1,2}일?/g, '[BIRTH DATE]'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [
    /(?:card\s*(?:number|no\.?|#)|credit\s*card)\s*[:：=#]?\s*\d(?:[ -]?\d){13,18}/gi,
    '[FINANCIAL ID]'
  ],
  [/(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)\d{3,4}[ .-]\d{4}(?!\w)/g, '[PHONE]'],
  [/(?<!\d)01[016789]\d{7,8}(?!\d)/g, '[PHONE]']
]

function redactUrls(input: string): string {
  const redact = (url: string): string =>
    `[LINK]${url.slice(url.replace(/[),.!?;]+$/g, '').length)}`
  return input.replace(URL_PATTERN, redact).replace(IPV4_URL_PATTERN, redact)
}

function redactBareHosts(input: string): string {
  const redact = (url: string): string =>
    `[LINK]${url.slice(url.replace(/[),.!?;]+$/g, '').length)}`
  return input.replace(BARE_HOST_PATTERN, redact)
}

function redactMarkdownDestinations(input: string): string {
  let result = ''
  let cursor = 0
  for (const match of input.matchAll(MARKDOWN_START_PATTERN)) {
    const start = match.index
    if (start < cursor) continue
    const label = match[1]
    const open = start + match[0].length - 1
    let depth = 1
    let escaped = false
    let end = open + 1
    for (; end < input.length && end - open <= 2048; end += 1) {
      const char = input[end]
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '(') depth += 1
      if (char === ')' && --depth === 0) break
    }
    if (depth !== 0 || end >= input.length || end - open > 2048) continue
    result += input.slice(cursor, start)
    const safeLabel = URL_PATTERN.test(label) || BARE_HOST_PATTERN.test(label) ? '[LINK]' : label
    URL_PATTERN.lastIndex = 0
    BARE_HOST_PATTERN.lastIndex = 0
    result += `[${safeLabel}]([LINK])`
    cursor = end + 1
  }
  return result + input.slice(cursor)
}

export function redactAiMailInput(input: string): string {
  if (typeof input !== 'string' || input.length > 100_000) throw new Error('invalid_ai_input')

  let result = input.replace(
    MARKDOWN_REFERENCE_PATTERN,
    (_match, prefix: string, destination: string, suffix: string) => {
      const bareDestination = destination.replace(/^<|>$/g, '')
      return `${prefix}${bareDestination ? '[LINK]' : destination}${suffix}`
    }
  )
  result = redactMarkdownDestinations(result)
  result = redactUrls(result)
  result = result.replace(
    /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g,
    '[TOKEN]'
  )
  result = redactBareHosts(result)
  for (const [pattern, replacement] of REDACTIONS) result = result.replace(pattern, replacement)
  return result
}
