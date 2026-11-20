import type { OllamaGenerationRequest, OllamaGenerationResult } from '~/shared/ipc'
import type { AppSettings } from '~/shared/settings'
import type { AiModelPort } from '~/main/ai/ai-model-port'
import { isAiMailConversationId } from '~/shared/ipc'
import { redactAiMailInput } from '../redact-ai-mail-input'

const MAX_REQUESTS = 8
const MAX_REQUEST_BYTES = 48 * 1024

async function awaitWithAbort<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('cancelled')
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([value, aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

type Entry = {
  controller: AbortController
  owner: object
  generation: number
  model: string
  mode: 'local' | 'remote'
  endpoint: string
}

export function createAiMailOllamaGenerationService(options: {
  provider: AiModelPort
  settings: () => AppSettings | null
  remoteCredential: (endpoint: string) => Promise<string | null>
}): {
  generate(
    request: OllamaGenerationRequest,
    owner: object,
    isCurrent: () => boolean
  ): Promise<OllamaGenerationResult>
  cancel(requestId: string): boolean
  cancelOwner(owner: object): void
  dispose(): Promise<void>
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
      settings !== null &&
      entry.model ===
        (settings?.ollamaMode === 'remote' ? settings.ollamaRemoteModel : settings?.ollamaModel) &&
      entry.mode === settings.ollamaMode &&
      entry.endpoint === settings.ollamaRemoteEndpoint &&
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
    if (!isAiMailConversationId(request.conversationId))
      return { ok: false, error: 'failed', reason: 'invalid_conversation' }
    const initial = options.settings()
    const initialModel =
      initial?.ollamaMode === 'remote' ? initial.ollamaRemoteModel : initial?.ollamaModel
    if (initial?.aiMailProvider !== 'ollama' || !initialModel)
      return { ok: false, error: 'unavailable', reason: 'provider_unavailable' }
    const entry: Entry = {
      controller: new AbortController(),
      owner,
      generation: request.generation,
      model: initialModel,
      mode: initial.ollamaMode,
      endpoint: initial.ollamaRemoteEndpoint
    }
    pending.set(request.requestId, entry)
    try {
      const apiKey =
        entry.mode === 'remote'
          ? await awaitWithAbort(options.remoteCredential(entry.endpoint), entry.controller.signal)
          : null
      if (!current(entry, request, owner, isCurrent))
        return {
          ok: false,
          error: 'cancelled',
          reason: entry.controller.signal.aborted ? 'cancelled' : 'stale'
        }
      if (entry.mode === 'remote' && !apiKey)
        return { ok: false, error: 'unavailable', reason: 'remote_credential_missing' }
      const configuration = {
        provider: 'ollama' as const,
        mode: entry.mode,
        endpoint: entry.endpoint,
        apiKey,
        model: entry.model
      }
      const status = await options.provider.getStatus(configuration, entry.controller.signal)
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      if (status.state !== 'available' || (entry.mode === 'local' && !status.cloudDisabled))
        return { ok: false, error: 'unavailable', reason: 'model_unavailable' }
      const models = await options.provider.getModels(configuration, entry.controller.signal)
      if (!current(entry, request, owner, isCurrent))
        return {
          ok: false,
          error: 'cancelled',
          reason: entry.controller.signal.aborted ? 'cancelled' : 'stale'
        }
      if (!models.includes(entry.model))
        return { ok: false, error: 'unavailable', reason: 'model_unavailable' }
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      let prompt: string
      try {
        prompt = redactAiMailInput(request.prompt)
      } catch {
        return { ok: false, error: 'failed', reason: 'input_redaction_failed' }
      }
      const output = await options.provider.generate(
        {
          ...configuration,
          accountId: request.accountId,
          conversationId: request.conversationId,
          prompt,
          isCurrent: () => current(entry, request, owner, isCurrent)
        },
        entry.controller.signal
      )
      if (!current(entry, request, owner, isCurrent))
        return { ok: false, error: 'cancelled', reason: 'stale' }
      const validated = validateOutput(output)
      return validated
        ? { ok: true, output: validated }
        : { ok: false, error: 'failed', reason: 'invalid_output' }
    } catch {
      if (!current(entry, request, owner, isCurrent))
        return {
          ok: false,
          error: 'cancelled',
          reason: entry.controller.signal.aborted ? 'cancelled' : 'stale'
        }
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

  async function dispose(): Promise<void> {
    disposed = true
    for (const entry of pending.values()) entry.controller.abort()
    pending.clear()
    await options.provider.dispose()
  }

  return { generate, cancel, cancelOwner, dispose }
}

function validateOutput(
  value: unknown
): Extract<OllamaGenerationResult, { ok: true }>['output'] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const output = value as Record<string, unknown>
  if (output.kind === 'answer' && Object.keys(output).sort().join(',') === 'kind,text')
    return typeof output.text === 'string' && output.text.length <= 20_000
      ? { kind: 'answer', text: output.text }
      : null
  if (
    output.kind === 'proposal' &&
    typeof output.subject === 'string' &&
    output.subject.length <= 998 &&
    typeof output.body === 'string' &&
    output.body.length <= 20_000 &&
    Object.keys(output).sort().join(',') === 'body,kind,subject'
  )
    return { kind: 'proposal', subject: output.subject, body: output.body }
  if (typeof output.text !== 'string' || output.text.length > 20_000) return null
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
