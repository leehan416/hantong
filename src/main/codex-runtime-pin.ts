export type CodexRuntimePin = {
  readonly version: string
  readonly target: string
  readonly executableSha256: string | null
}

/**
 * Build-owned Codex runtime pin. The executable digest is distinct from the
 * verified upstream archive digest recorded in scripts/provision-codex-runtime.mjs.
 */
export const CODEX_RUNTIME_PIN: CodexRuntimePin = Object.freeze({
  version: '0.167.1',
  target: 'aarch64-apple-darwin',
  executableSha256: 'ebabe5f0d79145a9e61274ce9ecf7c02c9021b7b04bfa59b7e61ad4461c32b0b'
})
