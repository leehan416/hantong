import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import type {
  CodexConnectionStatus,
  ComposeSnapshotResult,
  ComposeTargetStatus
} from '../../shared/ipc'
import type { AppMessages } from './app-messages'
import {
  type AiMailTask,
  type AiMailSnapshotCapture,
  applyAiMailProposal,
  captureAiMailTargetSnapshot,
  createAiMailGenerationSequence,
  createAiMailTargetEpoch,
  createAiMailTargetRefreshCoordinator,
  finishAiMailSnapshotCapture,
  isAiMailSnapshotCaptureBusy,
  requestAiMailProposal,
  undoAiMailProposal
} from './ai-mail-panel-flow'

const GENERATION_ENABLED = false
const TEST_RESPONSE_MODE = true
const TARGET_REFRESH_INTERVAL_MS = 1500

type ReadySnapshot = Extract<ComposeSnapshotResult, { status: 'ready' }>
type ReadyTarget = Extract<ComposeTargetStatus, { status: 'ready' }>
type ProposalConflict = {
  operation: 'apply' | 'undo'
  currentVersion: string
  currentBody: string
}
type Proposal = {
  task: AiMailTask
  text: string
  subject?: string
  snapshot: ReadySnapshot
  applyId?: string
  applied: boolean
  busy: boolean
  feedback?: 'applied' | 'undone' | 'error' | 'stale' | 'busy'
  feedbackOperation?: 'apply' | 'undo'
  conflict?: ProposalConflict
}
type PanelMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  task?: AiMailTask
  tone?: 'error' | 'notice'
  retryRequest?: {
    instruction: string
    followUp?: string
    task: AiMailTask
    targetLanguage?: string
  }
  proposal?: Proposal
}
type Thread = { key: string; items: PanelMessage[] }

type Props = {
  activeAccountId: string | null
  layoutMode: 'top' | 'bottom' | 'left' | 'right'
  open: boolean
  captureSession: number
  text: AppMessages['aiMail']
  onClose: () => void
}

function targetKey(target: ReadyTarget | null): string {
  return target ? `${target.accountId}:${target.composeId}` : ''
}

function newId(): string {
  return globalThis.crypto.randomUUID()
}

function statusText(status: CodexConnectionStatus | null, text: Props['text']): string {
  if (!status) return text.checking
  switch (status.state) {
    case 'connecting':
      return text.connecting
    case 'connected':
      return text.connected
    case 'disconnected':
      return text.disconnected
    case 'unsupported':
      return text.unsupported
    case 'error':
      return text.connectionError
  }
}

export function AiMailPanel({
  activeAccountId,
  layoutMode,
  open,
  captureSession,
  text,
  onClose
}: Props): React.JSX.Element | null {
  const [targetStatus, setTargetStatus] = useState<ComposeTargetStatus>({ status: 'none' })
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null)
  const [codexBusy, setCodexBusy] = useState(false)
  const [statusFailed, setStatusFailed] = useState(false)
  const [snapshotCapture, setSnapshotCapture] = useState<AiMailSnapshotCapture | null>(null)
  const [capturedSnapshot, setCapturedSnapshot] = useState<ReadySnapshot | null>(null)
  const [snapshotStatus, setSnapshotStatus] = useState('')
  const [thread, setThread] = useState<Thread>({ key: '', items: [] })
  const [instruction, setInstruction] = useState('')
  const [selectedTask, setSelectedTask] = useState<AiMailTask>('revise')
  const [targetLanguage, setTargetLanguage] = useState('')
  const [pending, setPending] = useState<{ requestId: string; key: string } | null>(null)
  const [cancelError, setCancelError] = useState(false)
  const [copyErrorId, setCopyErrorId] = useState<string | null>(null)
  const [copySuccessId, setCopySuccessId] = useState<string | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const currentTargetKey = useRef('')
  const captureEpoch = useRef(createAiMailTargetEpoch())
  const pendingRequest = useRef<{ requestId: string; key: string } | null>(null)
  const codexActionRevision = useRef(0)
  const conversation = useRef<{ key: string; requestId: string } | null>(null)
  const generation = useRef(createAiMailGenerationSequence())
  const targetRefreshSession = useRef(captureSession)
  const [acceptedTargetRefresh, setAcceptedTargetRefresh] = useState<{
    accountId: string | null
    session: number
  } | null>(null)
  const targetRefresh = useRef(
    createAiMailTargetRefreshCoordinator({
      query: () => window.api.getAiMailComposeTargetStatus()
    })
  )
  const targetRefreshReady =
    acceptedTargetRefresh?.accountId === activeAccountId &&
    acceptedTargetRefresh.session === captureSession
  const target = useMemo<ReadyTarget | null>(
    () =>
      targetRefreshReady &&
      targetStatus.status === 'ready' &&
      targetStatus.accountId === activeAccountId
        ? targetStatus
        : null,
    [activeAccountId, targetRefreshReady, targetStatus]
  )
  const key = targetKey(target)
  const messages = thread.key === key ? thread.items : []
  const targetReady = Boolean(target)
  const snapshotBusy = isAiMailSnapshotCaptureBusy(open, captureSession, snapshotCapture)
  const generationAvailable =
    TEST_RESPONSE_MODE || (GENERATION_ENABLED && codexStatus?.state === 'connected')

  const acceptTargetStatus = useCallback(
    (status: ComposeTargetStatus): void => {
      setTargetStatus(status)
      const nextKey =
        status.status === 'ready' && status.accountId === activeAccountId
          ? `${status.accountId}:${status.composeId}`
          : ''
      const targetChanged = currentTargetKey.current !== nextKey
      captureEpoch.current.setTarget(nextKey)
      if (targetChanged) setSnapshotCapture(null)
      if (targetChanged) setInstruction('')
      if (targetChanged) {
        conversation.current = null
      }
      currentTargetKey.current = nextKey
      setThread((current) => (current.key === nextKey ? current : { key: nextKey, items: [] }))
      if (targetChanged) {
        setCapturedSnapshot(null)
        setSnapshotStatus('')
      }
      if (pendingRequest.current && pendingRequest.current.key !== nextKey) {
        void window.api
          .cancelAiMailGeneration(pendingRequest.current.requestId)
          .catch(() => setCancelError(true))
        pendingRequest.current = null
        setPending(null)
      }
    },
    [activeAccountId]
  )

  useEffect(() => {
    const captureEpochForEffect = captureEpoch.current
    const targetRefreshCoordinator = targetRefresh.current
    currentTargetKey.current = ''
    let current = true
    const unsubscribeTarget = window.api.onAiMailComposeTarget((status) => {
      if (!current) return
      if (!targetRefreshCoordinator.accept()) return
      acceptTargetStatus(status)
      setAcceptedTargetRefresh({
        accountId: activeAccountId,
        session: targetRefreshSession.current
      })
    })
    const unsubscribeCodex = window.api.onAiMailCodexStatus((status) => {
      if (current) setCodexStatus(status)
    })
    void window.api.getAiMailCodexStatus().then(
      (nextCodex) => {
        if (!current) return
        setCodexStatus(nextCodex)
        setStatusFailed(false)
      },
      () => {
        if (current) setStatusFailed(true)
      }
    )
    return () => {
      current = false
      captureEpochForEffect.invalidate()
      unsubscribeTarget()
      unsubscribeCodex()
    }
  }, [activeAccountId, acceptTargetStatus])

  useEffect(() => {
    const targetRefreshCoordinator = targetRefresh.current
    targetRefreshSession.current = captureSession
    targetRefreshCoordinator.setActive(open)
    if (!open) return
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const outcome = await targetRefreshCoordinator.query()
        if (outcome.current) {
          acceptTargetStatus(outcome.status)
          setAcceptedTargetRefresh({ accountId: activeAccountId, session: captureSession })
        }
      } catch {
        // Keep the last known target while the bounded refresh retries.
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), TARGET_REFRESH_INTERVAL_MS)
      }
    }
    void refresh()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      targetRefreshCoordinator.setActive(false)
    }
  }, [open, activeAccountId, captureSession, acceptTargetStatus])

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
    else captureEpoch.current.invalidate()
  }, [open])

  const updateMessage = useCallback(
    (messageId: string, update: (message: PanelMessage) => PanelMessage) => {
      setThread((current) => ({
        ...current,
        items: current.items.map((message) =>
          message.id === messageId ? update(message) : message
        )
      }))
    },
    []
  )

  async function captureDraft(): Promise<void> {
    if (!target || snapshotBusy) return
    const targetKeyAtStart = targetKey(target)
    const capture: AiMailSnapshotCapture = {
      ...captureEpoch.current.capture(targetKeyAtStart),
      session: captureSession
    }
    setSnapshotCapture(capture)
    setSnapshotStatus(text.loadingSnapshot)
    const outcome = await captureAiMailTargetSnapshot(captureEpoch.current, capture, () =>
      window.api.getAiMailComposeSnapshot()
    )
    if (outcome.status === 'stale') {
      setSnapshotCapture((current) => finishAiMailSnapshotCapture(current, capture))
      return
    }
    if (outcome.status === 'error') {
      setSnapshotStatus(text.staleTarget)
    } else {
      const result = outcome.result
      if (result.status !== 'ready') {
        setCapturedSnapshot(null)
        setSnapshotStatus(
          result.status === 'stale'
            ? text.staleTarget
            : result.status === 'access_locked'
              ? text.lockedTarget
              : result.status === 'unsupported'
                ? text.unsupportedTarget
                : text.noTarget
        )
      } else if (result.accountId !== target.accountId || result.composeId !== target.composeId) {
        setCapturedSnapshot(null)
        setSnapshotStatus(text.staleTarget)
      } else {
        setCapturedSnapshot(result)
        setSnapshotStatus(text.captured)
      }
    }
    setSnapshotCapture((current) => finishAiMailSnapshotCapture(current, capture))
  }

  async function connectCodex(): Promise<void> {
    if (codexBusy) return
    const revision = ++codexActionRevision.current
    setCodexBusy(true)
    setStatusFailed(false)
    try {
      const status = await window.api.connectAiMailCodex()
      if (codexActionRevision.current === revision) setCodexStatus(status)
    } catch {
      if (codexActionRevision.current === revision) {
        setStatusFailed(true)
        setCodexStatus({ state: 'error' })
      }
    } finally {
      if (codexActionRevision.current === revision) setCodexBusy(false)
    }
  }

  function showTestResponse(): void {
    if (target) {
      void runGeneration(instruction.trim(), undefined)
      return
    }
    setThread((current) => ({
      key,
      items: [
        ...(current.key === key ? current.items : []),
        { id: newId(), role: 'assistant', text: text.testResponseText }
      ]
    }))
  }

  async function disconnectCodex(): Promise<void> {
    if (codexBusy && codexStatus?.state !== 'connecting') return
    const revision = ++codexActionRevision.current
    setCodexBusy(true)
    try {
      const status = await window.api.disconnectAiMailCodex()
      if (codexActionRevision.current === revision) setCodexStatus(status)
    } catch {
      if (codexActionRevision.current === revision) {
        setStatusFailed(true)
        setCodexStatus({ state: 'error' })
      }
    } finally {
      if (codexActionRevision.current === revision) setCodexBusy(false)
    }
  }

  async function runGeneration(
    requestText: string,
    followUp?: string,
    task: AiMailTask = selectedTask,
    language: string = targetLanguage
  ): Promise<void> {
    if (!target || !generationAvailable || pending || (task === 'translate' && !language.trim()))
      return
    const currentKey = key
    const conversationKey = `${currentKey}:${task}:${task === 'translate' ? language : ''}`
    if (conversation.current?.key !== conversationKey) {
      conversation.current = { key: conversationKey, requestId: newId() }
    }
    const requestId = conversation.current.requestId
    const requestGeneration = generation.current.next(currentKey)
    const retryRequest = {
      instruction: requestText,
      task,
      ...(followUp ? { followUp } : {}),
      ...(task === 'translate' ? { targetLanguage: language } : {})
    }
    const userMessage: PanelMessage = {
      id: newId(),
      role: 'user',
      task,
      text: followUp ?? (requestText || text.taskLabels[task])
    }
    setThread((current) => ({
      key: currentKey,
      items: current.key === currentKey ? [...current.items, userMessage] : [userMessage]
    }))
    setInstruction('')
    setPending({ requestId, key: currentKey })
    pendingRequest.current = { requestId, key: currentKey }
    setCancelError(false)
    try {
      const outcome = await requestAiMailProposal(
        TEST_RESPONSE_MODE
          ? {
              ...window.api,
              generateAiMailDraft: async () => ({
                ok: true,
                text:
                  task === 'subject' || task === 'translate'
                    ? JSON.stringify({
                        subject: task === 'subject' ? text.testSubject : text.testTranslatedSubject,
                        body: task === 'subject' ? text.testSuggestedBody : text.testTranslatedBody
                      })
                    : task === 'summary'
                      ? text.testSummary
                      : text.testResponseText,
                usage: { inputTokens: null, outputTokens: null }
              })
            }
          : window.api,
        target,
        requestText,
        requestId,
        requestGeneration,
        followUp,
        { task, ...(task === 'translate' ? { targetLanguage: language } : {}) }
      )
      if (
        currentTargetKey.current !== currentKey ||
        (TEST_RESPONSE_MODE && pendingRequest.current?.requestId !== requestId)
      )
        return
      if (outcome.status === 'ready') {
        setThread((current) => ({
          key: currentKey,
          items: [
            ...(current.key === currentKey ? current.items : []),
            {
              id: newId(),
              role: 'assistant',
              text: text.proposal,
              proposal: {
                task: outcome.task,
                text: outcome.text,
                ...(outcome.subject !== undefined ? { subject: outcome.subject } : {}),
                snapshot: outcome.snapshot,
                applied: false,
                busy: false
              }
            }
          ]
        }))
      } else {
        const message =
          outcome.status === 'invalid_output'
            ? text.invalidOutput
            : outcome.status === 'invalid_request'
              ? text.chooseLanguage
              : outcome.status === 'unavailable'
                ? outcome.result.status === 'stale'
                  ? text.staleTarget
                  : outcome.result.status === 'access_locked'
                    ? text.lockedTarget
                    : outcome.result.status === 'unsupported'
                      ? text.unsupportedTarget
                      : text.noTarget
                : outcome.status === 'stale'
                  ? text.staleTarget
                  : outcome.result.error === 'unauthenticated'
                    ? text.unauthenticated
                    : outcome.result.error === 'rate_limited'
                      ? text.rateLimited
                      : outcome.result.error === 'cancelled'
                        ? text.cancelled
                        : outcome.result.error === 'unsupported'
                          ? text.generationUnsupported
                          : text.generationError
        setThread((current) => ({
          key: currentKey,
          items: [
            ...(current.key === currentKey ? current.items : []),
            {
              id: newId(),
              role: 'assistant',
              text: message,
              tone:
                outcome.status === 'failed' || outcome.status === 'invalid_output'
                  ? 'error'
                  : 'notice',
              retryRequest
            }
          ]
        }))
      }
    } catch {
      if (
        currentTargetKey.current !== currentKey ||
        (TEST_RESPONSE_MODE && pendingRequest.current?.requestId !== requestId)
      )
        return
      setThread((current) => ({
        key: currentKey,
        items: [
          ...(current.key === currentKey ? current.items : []),
          {
            id: newId(),
            role: 'assistant',
            text: text.generationError,
            tone: 'error',
            retryRequest
          }
        ]
      }))
    } finally {
      pendingRequest.current =
        pendingRequest.current?.requestId === requestId ? null : pendingRequest.current
      setPending((current) => (current?.requestId === requestId ? null : current))
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const nextInstruction = instruction.trim()
    if (
      (selectedTask === 'revise' && !nextInstruction) ||
      (selectedTask === 'translate' && !targetLanguage) ||
      !target ||
      !generationAvailable
    )
      return
    const firstRequest = messages.find(
      (message) => message.role === 'user' && message.task === selectedTask
    )?.text
    await runGeneration(
      firstRequest ?? nextInstruction,
      firstRequest ? nextInstruction : undefined,
      selectedTask,
      targetLanguage
    )
  }

  async function cancelGeneration(): Promise<void> {
    if (!pending) return
    if (TEST_RESPONSE_MODE) {
      pendingRequest.current = null
      conversation.current = null
      setPending(null)
      setThread((current) => ({
        ...current,
        items: [
          ...current.items,
          { id: newId(), role: 'assistant', text: text.cancelled, tone: 'notice' }
        ]
      }))
      return
    }
    try {
      const result = await window.api.cancelAiMailGeneration(pending.requestId)
      if (result.cancelled) {
        setPending(null)
        pendingRequest.current = null
        setThread((current) => ({
          ...current,
          items: [
            ...current.items,
            { id: newId(), role: 'assistant', text: text.cancelled, tone: 'notice' }
          ]
        }))
      } else setCancelError(true)
    } catch {
      setCancelError(true)
    }
  }

  function setProposalBusy(messageId: string, busy: boolean): void {
    updateMessage(messageId, (message) =>
      message.proposal ? { ...message, proposal: { ...message.proposal, busy } } : message
    )
  }

  async function mutateProposal(
    messageId: string,
    operation: 'apply' | 'undo',
    confirmedCurrentVersion?: string
  ): Promise<void> {
    const item = (thread.key === key ? thread.items : []).find(
      (message) => message.id === messageId
    )
    const proposal = item?.proposal
    if (
      !proposal ||
      proposal.task === 'summary' ||
      proposal.busy ||
      proposal.snapshot.accountId !== activeAccountId ||
      !target
    )
      return
    setProposalBusy(messageId, true)
    try {
      const result =
        operation === 'apply'
          ? await applyAiMailProposal(
              window.api,
              proposal.snapshot,
              proposal.text,
              confirmedCurrentVersion
            )
          : proposal.applyId
            ? await undoAiMailProposal(
                window.api,
                proposal.snapshot,
                proposal.applyId,
                confirmedCurrentVersion
              )
            : { status: 'failed' as const }
      if (result.status === 'conflict') {
        updateMessage(messageId, (message) =>
          message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  busy: false,
                  conflict: {
                    operation,
                    currentVersion: result.currentVersion,
                    currentBody: result.currentBody
                  }
                }
              }
            : message
        )
      } else if (result.status === 'applied') {
        updateMessage(messageId, (message) =>
          message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  applyId: result.applyId,
                  applied: true,
                  busy: false,
                  feedback: 'applied',
                  feedbackOperation: 'apply',
                  conflict: undefined
                }
              }
            : message
        )
      } else if (result.status === 'undone') {
        updateMessage(messageId, (message) =>
          message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  applied: false,
                  busy: false,
                  feedback: 'undone',
                  feedbackOperation: 'undo',
                  conflict: undefined
                }
              }
            : message
        )
      } else {
        updateMessage(messageId, (message) =>
          message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  busy: false,
                  feedback:
                    result.status === 'busy'
                      ? 'busy'
                      : result.status === 'stale_target'
                        ? 'stale'
                        : 'error',
                  feedbackOperation: operation,
                  conflict: undefined
                }
              }
            : message
        )
      }
    } catch {
      updateMessage(messageId, (message) =>
        message.proposal
          ? { ...message, proposal: { ...message.proposal, busy: false, feedback: 'error' } }
          : message
      )
    }
  }

  async function copyProposal(messageId: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopyErrorId(null)
      setCopySuccessId(messageId)
    } catch {
      setCopyErrorId(messageId)
    }
  }

  if (!open) return null

  const codexLabel = statusFailed ? text.connectionError : statusText(codexStatus, text)
  const targetMessage = !targetRefreshReady
    ? text.checking
    : targetStatus.status === 'ready' && !target
      ? text.staleTarget
      : targetStatus.status === 'unsupported'
        ? text.unsupportedTarget
        : targetStatus.status === 'stale'
          ? text.staleTarget
          : targetStatus.status === 'access_locked'
            ? text.lockedTarget
            : text.noTarget

  return (
    <aside className={`ai-mail-panel ai-mail-panel-${layoutMode}`} aria-labelledby="ai-mail-title">
      <header className="ai-mail-heading">
        <div>
          <h1 id="ai-mail-title">{text.title}</h1>
          <p>{text.caption}</p>
        </div>
        <button
          ref={closeButtonRef}
          className="ai-mail-close"
          type="button"
          aria-label={text.close}
          title={text.close}
          onClick={onClose}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>

      <section className="ai-mail-connection" aria-label={text.codex}>
        <span
          className={`ai-mail-connection-dot ai-mail-state-${codexStatus?.state ?? 'checking'}`}
          aria-hidden="true"
        />
        <div className="ai-mail-connection-copy">
          <strong>{codexLabel}</strong>
          {TEST_RESPONSE_MODE && <p>{text.testResponseMode}</p>}
          {codexStatus?.state === 'connected' && <p>{text.generationBlocked}</p>}
          <button
            className="ai-mail-secondary"
            type="button"
            disabled={
              !targetReady || Boolean(pending) || (selectedTask === 'translate' && !targetLanguage)
            }
            onClick={showTestResponse}
          >
            {text.testResponse}
          </button>
        </div>
        {codexStatus?.state === 'connected' ? (
          <button
            className="ai-mail-text-button"
            type="button"
            disabled={codexBusy}
            onClick={() => void disconnectCodex()}
          >
            {text.disconnect}
          </button>
        ) : codexStatus?.state === 'connecting' ? (
          <button
            className="ai-mail-text-button"
            type="button"
            onClick={() => void disconnectCodex()}
          >
            {text.cancelLogin}
          </button>
        ) : (
          <button
            className="ai-mail-text-button"
            type="button"
            disabled={codexBusy}
            onClick={() => void connectCodex()}
          >
            {codexBusy
              ? text.checking
              : codexStatus?.state === 'error'
                ? text.reconnect
                : text.connect}
          </button>
        )}
      </section>

      <section className="ai-mail-target" aria-labelledby="ai-mail-target-title">
        <h2 id="ai-mail-target-title">{text.targetTitle}</h2>
        {target ? (
          <div className="ai-mail-target-card">
            <strong>{target.accountLabel}</strong>
            <span>{target.subject.trim() || text.newMessage}</span>
            {target.recipients.length > 0 && (
              <span className="ai-mail-target-recipients">{target.recipients.join(', ')}</span>
            )}
            <button
              className="ai-mail-text-button"
              type="button"
              disabled={snapshotBusy}
              onClick={() => void captureDraft()}
            >
              {snapshotBusy ? text.loadingSnapshot : text.capture}
            </button>
            {snapshotStatus && (
              <p className="ai-mail-inline-status" role="status">
                {snapshotStatus}
              </p>
            )}
            {capturedSnapshot &&
              capturedSnapshot.accountId === target.accountId &&
              capturedSnapshot.composeId === target.composeId && (
                <details open className="ai-mail-captured">
                  <summary>{text.capturedDraft}</summary>
                  <p>
                    <strong>{text.subjectLabel}</strong>{' '}
                    {capturedSnapshot.subject || text.newMessage}
                  </p>
                  <pre>{capturedSnapshot.body || text.newMessage}</pre>
                  <button
                    className="ai-mail-text-button"
                    type="button"
                    onClick={() => {
                      setCapturedSnapshot(null)
                      setSnapshotStatus('')
                    }}
                  >
                    {text.clearCapture}
                  </button>
                </details>
              )}
          </div>
        ) : (
          <p className="ai-mail-empty-target" role="status">
            {targetMessage}
          </p>
        )}
      </section>

      <section className="ai-mail-conversation" aria-label={text.title} aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`ai-mail-message ai-mail-message-${message.role}`}>
            <p className={message.tone === 'error' ? 'ai-mail-error' : undefined}>{message.text}</p>
            {message.retryRequest && generationAvailable && (
              <button
                className="ai-mail-text-button"
                type="button"
                onClick={() =>
                  void runGeneration(
                    message.retryRequest?.instruction ?? '',
                    message.retryRequest?.followUp,
                    message.retryRequest?.task,
                    message.retryRequest?.targetLanguage
                  )
                }
              >
                {text.retry}
              </button>
            )}
            {message.proposal && (
              <div className="ai-mail-proposal">
                <h2>{text.taskLabels[message.proposal.task]}</h2>
                {message.proposal.subject !== undefined && (
                  <div className="ai-mail-suggested-subject">
                    <strong>{text.suggestedSubject}</strong>
                    <p>{message.proposal.subject || text.newMessage}</p>
                    <button
                      className="ai-mail-text-button"
                      type="button"
                      onClick={() => void copyProposal(message.id, message.proposal?.subject ?? '')}
                    >
                      {text.copySubject}
                    </button>
                  </div>
                )}
                <strong>{text.outputLabels[message.proposal.task]}</strong>
                <pre>{message.proposal.text}</pre>
                <div className="ai-mail-proposal-actions">
                  {message.proposal.task !== 'summary' && !message.proposal.applied ? (
                    <button
                      className="ai-mail-primary"
                      type="button"
                      disabled={
                        message.proposal.busy ||
                        !target ||
                        target.accountId !== message.proposal.snapshot.accountId ||
                        target.composeId !== message.proposal.snapshot.composeId
                      }
                      onClick={() => void mutateProposal(message.id, 'apply')}
                    >
                      {message.proposal.busy ? text.loadingSnapshot : text.apply}
                    </button>
                  ) : message.proposal.task !== 'summary' ? (
                    <button
                      className="ai-mail-text-button"
                      type="button"
                      disabled={message.proposal.busy}
                      onClick={() => void mutateProposal(message.id, 'undo')}
                    >
                      {text.undo}
                    </button>
                  ) : null}
                  <button
                    className="ai-mail-secondary"
                    type="button"
                    disabled={message.proposal.busy}
                    onClick={() => void copyProposal(message.id, message.proposal?.text ?? '')}
                  >
                    {message.proposal.task === 'summary' ? text.copySummary : text.copy}
                  </button>
                </div>
                {message.proposal.feedback && (
                  <p
                    className={
                      ['error', 'stale', 'busy'].includes(message.proposal.feedback)
                        ? 'ai-mail-error'
                        : 'ai-mail-inline-status'
                    }
                    role={
                      ['error', 'stale', 'busy'].includes(message.proposal.feedback)
                        ? 'alert'
                        : 'status'
                    }
                  >
                    {message.proposal.feedback === 'applied'
                      ? text.applied
                      : message.proposal.feedback === 'undone'
                        ? text.undone
                        : message.proposal.feedback === 'stale'
                          ? text.staleMutation
                          : message.proposal.feedback === 'busy'
                            ? text.busy
                            : message.proposal.feedbackOperation === 'undo'
                              ? text.undoError
                              : text.applyError}
                  </p>
                )}
                {message.proposal.conflict && (
                  <section
                    className="ai-mail-conflict"
                    aria-labelledby={`ai-mail-conflict-${message.id}`}
                  >
                    <h3 id={`ai-mail-conflict-${message.id}`}>
                      {message.proposal.conflict.operation === 'apply'
                        ? text.conflictApplyTitle
                        : text.conflictUndoTitle}
                    </h3>
                    <p>
                      {message.proposal.conflict.operation === 'apply'
                        ? text.conflictApply
                        : text.conflictUndo}
                    </p>
                    <details>
                      <summary>{text.currentBody}</summary>
                      <pre>{message.proposal.conflict.currentBody}</pre>
                    </details>
                    <div className="ai-mail-proposal-actions">
                      <button
                        className="ai-mail-primary"
                        type="button"
                        disabled={message.proposal.busy}
                        onClick={() =>
                          void mutateProposal(
                            message.id,
                            message.proposal?.conflict?.operation ?? 'apply',
                            message.proposal?.conflict?.currentVersion
                          )
                        }
                      >
                        {message.proposal.conflict.operation === 'apply'
                          ? text.confirmApply
                          : text.confirmUndo}
                      </button>
                      <button
                        className="ai-mail-secondary"
                        type="button"
                        onClick={() =>
                          updateMessage(message.id, (current) =>
                            current.proposal
                              ? {
                                  ...current,
                                  proposal: { ...current.proposal, conflict: undefined }
                                }
                              : current
                          )
                        }
                      >
                        {text.keepEditing}
                      </button>
                    </div>
                  </section>
                )}
                {copyErrorId === message.id && (
                  <p className="ai-mail-error" role="alert">
                    {text.copyError}
                  </p>
                )}
                {copySuccessId === message.id && (
                  <p className="ai-mail-inline-status" role="status">
                    {text.copied}
                  </p>
                )}
              </div>
            )}
          </article>
        ))}
        {pending && (
          <div className="ai-mail-pending" role="status">
            <span className="ai-mail-pulse" aria-hidden="true" />
            <span>{text.generating}</span>
            <button
              className="ai-mail-text-button"
              type="button"
              onClick={() => void cancelGeneration()}
            >
              {text.cancelGeneration}
            </button>
            {cancelError && <p className="ai-mail-error">{text.cancelFailed}</p>}
          </div>
        )}
      </section>

      <form className="ai-mail-compose" noValidate onSubmit={(event) => void handleSubmit(event)}>
        <fieldset className="ai-mail-choice-group" disabled={!targetReady || Boolean(pending)}>
          <legend>{text.taskLabel}</legend>
          {(['revise', 'subject', 'summary', 'translate'] as const).map((task) => (
            <label key={task}>
              <input
                type="radio"
                name="ai-mail-task"
                value={task}
                checked={selectedTask === task}
                onChange={() => setSelectedTask(task)}
              />
              <span>{text.taskLabels[task]}</span>
            </label>
          ))}
        </fieldset>
        {selectedTask === 'translate' && (
          <fieldset className="ai-mail-choice-group" disabled={!targetReady || Boolean(pending)}>
            <legend>{text.targetLanguage}</legend>
            <label>
              <input
                type="radio"
                name="ai-mail-language"
                value="English"
                checked={targetLanguage === 'English'}
                onChange={() => setTargetLanguage('English')}
              />
              <span>English</span>
            </label>
            <label>
              <input
                type="radio"
                name="ai-mail-language"
                value="Korean"
                checked={targetLanguage === 'Korean'}
                onChange={() => setTargetLanguage('Korean')}
              />
              <span>한국어</span>
            </label>
          </fieldset>
        )}
        <label htmlFor="ai-mail-instruction">
          {selectedTask === 'revise' ? text.requestLabel : text.optionalInstruction}
        </label>
        <textarea
          id="ai-mail-instruction"
          className="resize-none"
          value={instruction}
          maxLength={2000}
          placeholder={targetReady ? text.taskPlaceholders[selectedTask] : text.noTarget}
          disabled={!targetReady || Boolean(pending)}
          onChange={(event) => setInstruction(event.target.value)}
        />
        <p className="ai-mail-privacy">
          {generationAvailable
            ? TEST_RESPONSE_MODE
              ? text.testResponseMode
              : text.privacy
            : codexStatus?.state === 'connected'
              ? text.generationBlocked
              : text.connectFirst}
        </p>
        <button
          className="ai-mail-primary"
          type="submit"
          disabled={
            !targetReady ||
            (selectedTask === 'revise' && !instruction.trim()) ||
            (selectedTask === 'translate' && !targetLanguage) ||
            !generationAvailable ||
            Boolean(pending)
          }
        >
          {pending ? text.generating : text.taskActions[selectedTask]}
        </button>
      </form>
    </aside>
  )
}
