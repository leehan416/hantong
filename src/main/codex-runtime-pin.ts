export type CodexRuntimePin = {
  readonly version: string
  readonly target: string
  readonly executableSha256: string | null
}

/**
 * Build-owned Codex runtime pin. Populate the executable digest only when the
 * approved upstream archive is verified and provisioned into app resources.
 */
export const CODEX_RUNTIME_PIN: CodexRuntimePin = Object.freeze({
  version: '0.167.1',
  target: 'aarch64-apple-darwin',
  executableSha256: null
})
