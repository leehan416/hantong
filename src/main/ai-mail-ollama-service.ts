import type { OllamaGenerationRequest, OllamaGenerationResult } from '../shared/ipc'
import type { AppSettings } from '../shared/settings'
import type { createOllamaService } from './ollama-service'

const MAX_REQUESTS = 8
const MAX_REQUEST_BYTES = 48 * 1024

type Entry = { controller: AbortController; owner: object; generation: number; model: string }

export function createAiMailOllamaGenerationService(options: {
  ollama: ReturnType<typeof createOllamaService>
  settings: () => AppSettings | null
}): {
  generate(
    request: OllamaGenerationRequest,
    owner: object,
    isCurrent: () => boolean
  ): Promise<OllamaGenerationResult>
  cancel(requestId: string): boolean
  cancelOwner(owner: object): void
  dispose(): void
} {
  const pending = new Map<string, Entry>()
  let disposed = false

  function current(
    entry: Entry,
    request: OllamaGenerationRequest,
    owner: object,
    isCurrent: () => boolean
  ): boolean {
    const settings = options.settings()
    return (
      !disposed &&
      pending.get(request.requestId) === entry &&
      !entry.controller.signal.aborted &&
      entry.owner === owner &&
      entry.generation === request.generation &&
      entry.model === settings?.ollamaModel &&
      settings?.aiMailProvider === 'ollama' &&
      isCurrent()
    )
  }

  async function generate(
    request: OllamaGenerationRequest,
    owner: object,
    isCurrent: () => boolean
  ): Promise<OllamaGenerationResult> {
    if (disposed) return { ok: false, error: 'cancelled', reason: 'disposed' }
    if (pending.has(request.requestId))
      return { ok: false, error: 'failed', reason: 'duplicate_request' }
    if (
      pending.size >= MAX_REQUESTS ||
      new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_REQUEST_BYTES
    )
      return { ok: false, error: 'failed', reason: 'request_limit' }
    const initial = options.settings()
    if (initial?.aiMailProvider !== 'ollama' || !initial.ollamaModel)
      return { ok: false, error: 'unavailable', reason: 'provider_unavailable' }
    const entry: Entry = {
      controller: new AbortController(),
      owner,
      generation: request.generation,
      model: initial.ollamaModel
    }
    pending.set(request.requestId, entry)
    try {
      const status = await options.ollama.getStatus(entry.controller.signal)
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      if (status.state !== 'available' || !status.cloudDisabled)
        return { ok: false, error: 'unavailable', reason: 'local_model_unavailable' }
      await options.ollama.validateModel(entry.model, entry.controller.signal)
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      const output = await options.ollama.generateChat(
        entry.model,
        request.prompt,
        request.followUp,
        entry.controller.signal
      )
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      const validated = validateOutput(output)
      return validated
        ? { ok: true, output: validated }
        : { ok: false, error: 'failed', reason: 'invalid_output' }
    } catch {
      return {
        ok: false,
        error: entry.controller.signal.aborted ? 'cancelled' : 'failed',
        reason: entry.controller.signal.aborted ? 'cancelled' : 'generation_failed'
      }
    } finally {
      if (pending.get(request.requestId) === entry) pending.delete(request.requestId)
    }
  }

  function cancel(requestId: string): boolean {
    const entry = pending.get(requestId)
    if (!entry) return false
    entry.controller.abort()
    return true
  }

  function cancelOwner(owner: object): void {
    for (const entry of pending.values()) if (entry.owner === owner) entry.controller.abort()
  }

  function dispose(): void {
    disposed = true
    for (const entry of pending.values()) entry.controller.abort()
    pending.clear()
  }

  return { generate, cancel, cancelOwner, dispose }
}

function validateOutput(
  value: unknown
): Extract<OllamaGenerationResult, { ok: true }>['output'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = value as Record<string, unknown>
  if (typeof output.text !== 'string' || output.text.length > 20_000) return null
  if (output.kind === 'answer' && Object.keys(output).sort().join(',') === 'kind,text')
    return { kind: 'answer', text: output.text }
  if (
    output.kind === 'proposal' &&
    output.field === 'body' &&
    Object.keys(output).sort().join(',') === 'field,kind,text'
  )
    return { kind: 'proposal', field: 'body', text: output.text }
  if (
    output.kind === 'proposal' &&
    output.field === 'subject' &&
    typeof output.subject === 'string' &&
    output.subject.length <= 998 &&
    Object.keys(output).sort().join(',') === 'field,kind,subject,text'
  )
    return { kind: 'proposal', field: 'subject', text: output.text, subject: output.subject }
  return null
}
