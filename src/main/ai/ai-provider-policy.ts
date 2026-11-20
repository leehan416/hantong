import { isIP } from 'node:net'

function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'localhost.localdomain')
    return true
  if (isIP(host) === 4) return Number(host.split('.')[0]) === 127
  if (isIP(host) !== 6) return false
  if (host === '::1') return true
  const address = host.includes('.')
    ? host.replace(/(\d+\.\d+\.\d+\.\d+)$/, (ipv4) => {
        const octets = ipv4.split('.').map(Number)
        return `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`
      })
    : host
  const halves = address.split('::')
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const words =
    halves.length === 2
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
      : address.split(':')
  return (
    words.length === 8 &&
    words.slice(0, 5).every((word) => Number.parseInt(word || '0', 16) === 0) &&
    Number.parseInt(words[5], 16) === 0xffff &&
    Number.parseInt(words[6], 16) >> 8 === 127
  )
}

export function normalizeRemoteOllamaEndpoint(value: string): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid endpoint')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('Invalid endpoint')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isLoopbackHost(url.hostname)
  )
    throw new Error('Invalid endpoint')
  const path = url.pathname.replace(/\/+$/, '')
  if (path && path !== '/v1' && !path.endsWith('/v1')) throw new Error('Invalid endpoint')
  url.pathname = path || '/v1'
  return url.toString().replace(/\/$/, '')
}

export function isValidRemoteOllamaEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    normalizeRemoteOllamaEndpoint(value)
    return true
  } catch {
    return false
  }
}
