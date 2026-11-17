import type {
  AiMailComposeApplyRequest,
  AiMailComposeMutationResult,
  AiMailComposeUndoRequest,
  ComposeSnapshotResult,
  ComposeTargetStatus,
  CodexGenerationResult,
  HantongApi
} from '../../shared/ipc'
import prompts from './ai-mail-prompts.json'

type AiMailPanelApi = Pick<
  HantongApi,
  'getAiMailComposeSnapshot' | 'generateAiMailDraft' | 'applyAiMailDraft' | 'undoAiMailDraft'
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

export type AiMailProposalOutcome =
  | {
      status: 'ready'
      snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>
      task: AiMailTask
      text: string
      subject?: string
    }
  | { status: 'unavailable'; result: Exclude<ComposeSnapshotResult, { status: 'ready' }> }
  | { status: 'stale' }
  | { status: 'invalid_output' }
  | { status: 'invalid_request'; reason: 'target_language_required' }
  | { status: 'failed'; result: Extract<CodexGenerationResult, { ok: false }> }

export type AiMailTask = 'revise' | 'subject' | 'summary' | 'translate'

export interface AiMailTaskOptions {
  task: AiMailTask
  targetLanguage?: string
}

export async function requestAiMailProposal(
  api: AiMailPanelApi,
  target: Extract<ComposeTargetStatus, { status: 'ready' }>,
  instruction: string,
  requestId: string,
  generation: number,
  followUp?: string,
  options: AiMailTaskOptions = { task: 'revise' }
): Promise<AiMailProposalOutcome> {
  if (options.task === 'translate' && !options.targetLanguage?.trim())
    return { status: 'invalid_request', reason: 'target_language_required' }
  const snapshot = await api.getAiMailComposeSnapshot()
  if (snapshot.status !== 'ready') return { status: 'unavailable', result: snapshot }
  if (snapshot.accountId !== target.accountId || snapshot.composeId !== target.composeId)
    return { status: 'stale' }

  const prompt = [
    prompts[options.task],
    ...(instruction ? [`User instruction: ${instruction}`] : []),
    ...(options.task === 'translate'
      ? [`Target language: ${options.targetLanguage?.trim() ?? ''}`]
      : []),
    `Email subject:\n${snapshot.subject}`,
    `Email body:\n${snapshot.body}`
  ].join('\n\n')
  const generated = await api.generateAiMailDraft({
    accountId: target.accountId,
    composeId: target.composeId,
    requestId,
    generation,
    prompt,
    ...(followUp ? { followUp } : {})
  })
  if (!generated.ok) return { status: 'failed', result: generated }
  if (options.task === 'subject' || options.task === 'translate') {
    try {
      const output: unknown = JSON.parse(generated.text)
      if (!output || typeof output !== 'object' || Array.isArray(output))
        return { status: 'invalid_output' }
      if (
        Object.keys(output).sort().join(',') !== 'body,subject' ||
        !('subject' in output) ||
        typeof output.subject !== 'string' ||
        !('body' in output) ||
        typeof output.body !== 'string'
      )
        return { status: 'invalid_output' }
      return {
        status: 'ready',
        snapshot,
        task: options.task,
        text: output.body,
        subject: output.subject
      }
    } catch {
      return { status: 'invalid_output' }
    }
  }
  return { status: 'ready', snapshot, task: options.task, text: generated.text }
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
