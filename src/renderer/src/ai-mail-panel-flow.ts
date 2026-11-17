import type {
  AiMailComposeApplyRequest,
  AiMailComposeMutationResult,
  AiMailComposeUndoRequest,
  ComposeSnapshotResult,
  ComposeTargetStatus,
  CodexGenerationResult,
  HantongApi
} from '../../shared/ipc'

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
  | { status: 'ready'; snapshot: Extract<ComposeSnapshotResult, { status: 'ready' }>; text: string }
  | { status: 'unavailable'; result: Exclude<ComposeSnapshotResult, { status: 'ready' }> }
  | { status: 'stale' }
  | { status: 'failed'; result: Extract<CodexGenerationResult, { ok: false }> }

export async function requestAiMailProposal(
  api: AiMailPanelApi,
  target: Extract<ComposeTargetStatus, { status: 'ready' }>,
  instruction: string,
  requestId: string,
  generation: number,
  followUp?: string
): Promise<AiMailProposalOutcome> {
  const snapshot = await api.getAiMailComposeSnapshot()
  if (snapshot.status !== 'ready') return { status: 'unavailable', result: snapshot }
  if (snapshot.accountId !== target.accountId || snapshot.composeId !== target.composeId)
    return { status: 'stale' }

  const prompt = [
    `Request: ${instruction}`,
    snapshot.subject ? `Subject: ${snapshot.subject}` : 'Subject: (new message)',
    `Current draft:\n${snapshot.body}`
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
  return { status: 'ready', snapshot, text: generated.text }
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
