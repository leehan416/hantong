import type { createHash, randomBytes } from 'node:crypto'

export interface PkceCrypto {
  randomBytes: typeof randomBytes
  createHash: typeof createHash
}

export interface PkcePair {
  readonly state: string
  readonly verifier: string
  readonly challenge: string
}

export function createPkcePair(crypto: PkceCrypto): PkcePair {
  const state = crypto.randomBytes(32).toString('base64url')
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')
  return { state, verifier, challenge }
}
