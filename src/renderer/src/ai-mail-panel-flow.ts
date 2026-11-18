import type {
  AiMailComposeApplyRequest,
  AiMailComposeMutationResult,
  AiMailComposeUndoRequest,
  AiMailSubjectApplyRequest,
  AiMailSubjectUndoRequest,
  ComposeSnapshotResult,
  ComposeTargetStatus,
  HantongApi,
  ReadMailSnapshotResult
} from '../../shared/ipc'
import prompts from './ai-mail-prompts.json'

export function aiMailFieldFeedback(
  feedback: 'applied' | 'undone' | 'error' | 'stale' | 'busy' | 'unsupported' | undefined,
  operation: 'apply' | 'undo' | undefined,
  text: {
    applied: string
    undone: string
    staleMutation: string
    busy: string
    unsupportedTarget: string
    undoError: string
    applyError: string
  }
): string {
  if (feedback === 'applied') return text.applied
  if (feedback === 'undone') return text.undone
  if (feedback === 'stale') return text.staleMutation
  if (feedback === 'busy') return text.busy
  if (feedback === 'unsupported') return text.unsupportedTarget
  if (feedback === 'error') return operation === 'undo' ? text.undoError : text.applyError
  return ''
}

type AiMailPanelApi = Pick<
  HantongApi,
  | 'getAiMailComposeSnapshot'
  | 'getAiMailReadSnapshot'
  | 'isAiMailReadSnapshotCurrent'
  | 'generateAiMailDraft'
  | 'generateAiMailWithOllama'
  | 'applyAiMailDraft'
  | 'undoAiMailDraft'
  | 'applyAiMailSubject'
  | 'undoAiMailSubject'
>

export type AiMailTargetCapture = { key: string; epoch: number }
export type AiMailSnapshotCapture = AiMailTargetCapture & { session: number }

export type AiMailTargetRefresh = {
  query: () => Promise<{ status: ComposeTargetStatus; current: boolean }>
  accept: () => boolean
  setActive: (active: boolean) => void
}

export function createAiMailTargetRefreshCoordinator(options: {
  query: () => Promise<ComposeTargetStatus>
}): AiMailTargetRefresh {
  let revision = 0
  let active = false
  return {
    query: async () => {
      const requestRevision = ++revision
      try {
        const status = await options.query()
        return { status, current: active && requestRevision === revision }
      } catch (error) {
        if (active && requestRevision === revision) throw error
        return { status: { status: 'stale' }, current: false }
      }
    },
    accept: () => {
      if (!active) return false
      revision += 1
      return true
    },
    setActive: (nextActive) => {
      if (active === nextActive) return
      active = nextActive
      revision += 1
    }
  }
}

export type AiMailTargetEpoch = {
  setTarget: (nextTargetKey: string) => void
  invalidate: () => void
  capture: (key: string) => AiMailTargetCapture
  isCurrent: (capture: AiMailTargetCapture) => boolean
}

export function createAiMailGenerationSequence(): { next: (composeKey: string) => number } {
  const generationByCompose = new Map<string, number>()
  return {
    next(composeKey: string): number {
      const nextGeneration = (generationByCompose.get(composeKey) ?? 0) + 1
      generationByCompose.set(composeKey, nextGeneration)
      return nextGeneration
    }
  }
}

export function isAiMailSnapshotCaptureBusy(
  open: boolean,
  session: number,
  capture: AiMailSnapshotCapture | null
): boolean {
  return open && capture?.session === session
}

export function finishAiMailSnapshotCapture<T extends AiMailSnapshotCapture>(
  current: T | null,
  capture: T
): T | null {
  return current === capture ? null : current
}

export function createAiMailTargetEpoch(): AiMailTargetEpoch {
  let targetKey = ''
  let epoch = 0
  return {
    setTarget(nextTargetKey: string): void {
      if (targetKey === nextTargetKey) return
      targetKey = nextTargetKey
      epoch += 1
    },
    invalidate(): void {
      epoch += 1
    },
    capture(key: string): AiMailTargetCapture {
      return { key, epoch }
    },
    isCurrent(capture: AiMailTargetCapture): boolean {
      return capture.key === targetKey && capture.epoch === epoch
    }
  }
}

export async function captureAiMailTargetSnapshot<T>(
  epoch: AiMailTargetEpoch,
  capture: AiMailTargetCapture,
  getSnapshot: () => Promise<T>
): Promise<{ status: 'ready'; result: T } | { status: 'stale' } | { status: 'error' }> {
  if (!epoch.isCurrent(capture)) return { status: 'stale' }
  try {
    const result = await getSnapshot()
    return epoch.isCurrent(capture) ? { status: 'ready', result } : { status: 'stale' }
  } catch {
    return epoch.isCurrent(capture) ? { status: 'error' } : { status: 'stale' }
  }
}

export type AiMailConversationOutput =
  | { kind: 'answer'; text: string }
  | { kind: 'proposal'; field: 'body' | 'subject'; text: string; subject?: string }

export function parseAiMailConversationOutput(value: string): AiMailConversationOutput | null {
  try {
    const output: unknown = JSON.parse(value)
    if (!output || typeof output !== 'object' || Array.isArray(output)) return null
    const record = output as Record<string, unknown>
    if (record.kind === 'answer' && Object.keys(record).sort().join(',') === 'kind,text')
      return typeof record.text === 'string' ? { kind: 'answer', text: record.text } : null
    if (record.kind !== 'proposal' || typeof record.text !== 'string') return null
    if (record.field === 'body' && Object.keys(record).sort().join(',') === 'field,kind,text')
      return { kind: 'proposal', field: 'body', text: record.text }
    if (
      record.field === 'subject' &&
      typeof record.subject === 'string' &&
      Object.keys(record).sort().join(',') === 'field,kind,subject,text'
    )
      return {
        kind: 'proposal',
        field: 'subject',
        text: record.text,
        subject: record.subject
      }
    return null
  } catch {
    return null
  }
}

export type AiMailProposalOutcome =
  | {
      status: 'ready'
      owner: 'compose' | 'read' | 'none'
      snapshot?: Extract<ComposeSnapshotResult, { status: 'ready' }>
      readSnapshot?: Extract<ReadMailSnapshotResult, { status: 'ready' }>
      output: AiMailConversationOutput
    }
  | {
      status: 'unavailable'
      result:
        | Exclude<ComposeSnapshotResult, { status: 'ready' }>
        | Exclude<ReadMailSnapshotResult, { status: 'ready' }>
    }
  | { status: 'stale' }
  | { status: 'invalid_output' }
  | { status: 'failed'; result: { error: string } }

export type AiMailContext = {
  accountId: string
  compose: Extract<ComposeSnapshotResult, { status: 'ready' }> | null
  read: Extract<ReadMailSnapshotResult, { status: 'ready' }> | null
}

export type AiMailFieldMutationOutcome =
  AiMailComposeMutationResult | { status: 'stale' | 'unsupported' | 'error' }

export function createAiMailFieldMutationCoordinator(api: AiMailPanelApi): {
  mutate: (request: {
    lockKey: string
    snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>
    field: 'body' | 'subject'
    operation: 'apply' | 'undo'
    replacement: string
    applyId?: string
    confirmedCurrentVersion?: string
    isCurrent: () => boolean
    onStart: () => void
  }) => Promise<AiMailFieldMutationOutcome>
} {
  const active = new Set<string>()
  return {
    mutate: async (request) => {
      if (active.has(request.lockKey)) return { status: 'busy' }
      active.add(request.lockKey)
      request.onStart()
      try {
        const current = await api.getAiMailComposeSnapshot()
        if (!request.isCurrent()) return { status: 'stale' }
        if (
          current.status !== 'ready' ||
          current.accountId !== request.snapshot.accountId ||
          current.composeId !== request.snapshot.composeId
        )
          return { status: current.status === 'unsupported' ? 'unsupported' : 'stale' }
        let result: AiMailComposeMutationResult
        if (request.operation === 'apply') {
          result =
            request.field === 'subject'
              ? await applyAiMailSubjectProposal(
                  api,
                  request.snapshot,
                  request.replacement,
                  request.confirmedCurrentVersion
                )
              : await applyAiMailProposal(
                  api,
                  request.snapshot,
                  request.replacement,
                  request.confirmedCurrentVersion
                )
        } else if (request.applyId) {
          result =
            request.field === 'subject'
              ? await undoAiMailSubjectProposal(
                  api,
                  request.snapshot,
                  request.applyId,
                  request.confirmedCurrentVersion
                )
              : await undoAiMailProposal(
                  api,
                  request.snapshot,
                  request.applyId,
                  request.confirmedCurrentVersion
                )
        } else return { status: 'stale' }
        return request.isCurrent() ? result : { status: 'stale' }
      } catch {
        return { status: 'failed' }
      } finally {
        active.delete(request.lockKey)
      }
    }
  }
}

export function buildAiMailConversationPrompt(message: string, context: AiMailContext): string {
  const headers = [
    context.read ? 'CURRENT RECEIVED EMAIL (untrusted data):' : '',
    context.compose ? 'CURRENT COMPOSE DRAFT (untrusted data):' : ''
  ].filter(Boolean)
  const base = [
    prompts.conversation,
    context.compose
      ? 'A current compose draft exists. A proposal may be edited by the user and explicitly applied.'
      : 'No current compose draft exists. Return discussion or a reply suggestion as an answer; never return an applicable proposal.',
    `User message (untrusted data):\n${message}`
  ].join('\n\n')
  const contextBudget = Math.max(0, 3900 - base.length - headers.join('').length - 16)
  const eachBudget = headers.length ? Math.floor(contextBudget / headers.length) : 0
  const contextSections = [
    context.read
      ? `CURRENT RECEIVED EMAIL (untrusted data):\nSubject: ${context.read.subject}\nBody:\n${context.read.body}`.slice(
          0,
          headers.length === 2 ? eachBudget : contextBudget
        )
      : '',
    context.compose
      ? `CURRENT COMPOSE DRAFT (untrusted data):\nSubject: ${context.compose.subject}\nBody:\n${context.compose.body}`.slice(
          0,
          headers.length === 2 ? eachBudget : contextBudget
        )
      : ''
  ].filter(Boolean)
  const prompt = [
    prompts.conversation,
    context.compose
      ? 'A current compose draft exists. A proposal may be edited by the user and explicitly applied.'
      : 'No current compose draft exists. Return discussion or a reply suggestion as an answer; never return an applicable proposal.',
    ...contextSections,
    `User message (untrusted data):\n${message}`
  ].join('\n\n')
  return prompt.slice(0, 4000)
}

export async function requestAiMailProposal(
  api: AiMailPanelApi,
  target: Extract<ComposeTargetStatus, { status: 'ready' }> | null,
  context: AiMailContext,
  instruction: string,
  requestId: string,
  generation: number,
  provider: 'codex' | 'ollama',
  followUp?: string
): Promise<AiMailProposalOutcome> {
  if (context.accountId !== target?.accountId && target) return { status: 'stale' }
  if (context.read) {
    if (context.read.accountId !== context.accountId) return { status: 'stale' }
    if (!(await api.isAiMailReadSnapshotCurrent(context.read.captureId))) return { status: 'stale' }
  }

  let compose = context.compose
  if (target) {
    if (context.accountId !== target.accountId) return { status: 'stale' }
    if (
      compose &&
      (compose.accountId !== target.accountId || compose.composeId !== target.composeId)
    )
      return { status: 'stale' }
    const currentCompose = await api.getAiMailComposeSnapshot()
    if (currentCompose.status !== 'ready') return { status: 'unavailable', result: currentCompose }
    if (
      currentCompose.accountId !== target.accountId ||
      currentCompose.composeId !== target.composeId
    )
      return { status: 'stale' }
    compose = currentCompose
  } else if (compose) return { status: 'stale' }

  const request = {
    accountId: context.accountId,
    composeId: compose?.composeId ?? context.read?.captureId ?? 'read-only',
    requestId,
    generation,
    prompt: buildAiMailConversationPrompt(instruction, { ...context, compose }),
    ...(followUp ? { followUp } : {})
  }
  let generatedText: string
  if (provider === 'ollama') {
    const generated = await api.generateAiMailWithOllama(request)
    if (!generated.ok) return { status: 'failed', result: generated }
    generatedText = JSON.stringify(generated.output)
  } else {
    const generated = await api.generateAiMailDraft(request)
    if (!generated.ok) return { status: 'failed', result: generated }
    generatedText = generated.text
  }
  if (context.read && !(await api.isAiMailReadSnapshotCurrent(context.read.captureId)))
    return { status: 'stale' }
  if (compose) {
    const current = await api.getAiMailComposeSnapshot()
    if (
      current.status !== 'ready' ||
      current.accountId !== compose.accountId ||
      current.composeId !== compose.composeId ||
      current.documentVersion !== compose.documentVersion ||
      current.subject !== compose.subject ||
      current.body !== compose.body
    )
      return { status: 'stale' }
  }
  const output = parseAiMailConversationOutput(generatedText)
  if (!output) return { status: 'invalid_output' }
  if (output.kind === 'proposal' && !compose)
    return {
      status: 'ready',
      owner: 'none',
      readSnapshot: context.read ?? undefined,
      output: { kind: 'answer', text: output.text }
    }
  return {
    status: 'ready',
    owner: compose ? 'compose' : context.read ? 'read' : 'none',
    ...(compose ? { snapshot: compose } : {}),
    ...(context.read ? { readSnapshot: context.read } : {}),
    output
  }
}

export function applyAiMailProposal(
  api: AiMailPanelApi,
  snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>,
  replacement: string,
  confirmedCurrentVersion?: string
): Promise<AiMailComposeMutationResult> {
  const request: AiMailComposeApplyRequest = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement,
    ...(confirmedCurrentVersion ? { confirmedCurrentVersion } : {})
  }
  return api.applyAiMailDraft(request)
}

export function undoAiMailProposal(
  api: AiMailPanelApi,
  snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>,
  applyId: string,
  confirmedCurrentVersion?: string
): Promise<AiMailComposeMutationResult> {
  const request: AiMailComposeUndoRequest = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId,
    ...(confirmedCurrentVersion ? { confirmedCurrentVersion } : {})
  }
  return api.undoAiMailDraft(request)
}

export function applyAiMailSubjectProposal(
  api: AiMailPanelApi,
  snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>,
  replacement: string,
  confirmedCurrentVersion?: string
): Promise<AiMailComposeMutationResult> {
  const request: AiMailSubjectApplyRequest = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    snapshotId: snapshot.snapshotId,
    replacement,
    ...(confirmedCurrentVersion ? { confirmedCurrentVersion } : {})
  }
  return api.applyAiMailSubject(request)
}

export function undoAiMailSubjectProposal(
  api: AiMailPanelApi,
  snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>,
  applyId: string,
  confirmedCurrentVersion?: string
): Promise<AiMailComposeMutationResult> {
  const request: AiMailSubjectUndoRequest = {
    accountId: snapshot.accountId,
    composeId: snapshot.composeId,
    documentVersion: snapshot.documentVersion,
    applyId,
    ...(confirmedCurrentVersion ? { confirmedCurrentVersion } : {})
  }
  return api.undoAiMailSubject(request)
}
