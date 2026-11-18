import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type {
  CodexConnectionStatus,
  ComposeSnapshotResult,
  ComposeTargetStatus,
  ReadMailSnapshotResult
} from '../../shared/ipc'
import type { AppMessages } from './app-messages'
import { AiMailChatLayout } from './AiMailChatLayout'
import {
  createAiMailGenerationSequence,
  createAiMailFieldMutationCoordinator,
  createAiMailTargetRefreshCoordinator,
  requestAiMailProposal,
  aiMailFieldFeedback
} from './ai-mail-panel-flow'

const GENERATION_ENABLED = false
const TARGET_REFRESH_INTERVAL_MS = 1500
const READ_TARGET_REFRESH_INTERVAL_MS = 5000

type ReadySnapshot = Extract<ComposeSnapshotResult, { status: 'ready' }>
type ReadyReadSnapshot = Extract<ReadMailSnapshotResult, { status: 'ready' }>
type ReadyTarget = Extract<ComposeTargetStatus, { status: 'ready' }>
type FieldState = {
  value: string
  applied: boolean
  applyId?: string
  busy: boolean
  feedback?: 'applied' | 'undone' | 'error' | 'stale' | 'busy' | 'unsupported'
  lastOperation?: 'apply' | 'undo'
  conflict?: { currentVersion: string; currentBody: string; operation: 'apply' | 'undo' }
}
type Proposal = {
  snapshot: ReadySnapshot
  subject?: FieldState
  body: FieldState
}
type PanelMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  tone?: 'error' | 'notice'
  proposal?: Proposal
}

type Props = {
  activeAccountId: string | null
  layoutMode: 'top' | 'bottom' | 'left' | 'right'
  open: boolean
  captureSession: number
  text: AppMessages['aiMail']
  onClose: () => void
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

function targetKey(target: ReadyTarget | null): string {
  return target ? `${target.accountId}:${target.composeId}` : ''
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
  const [readyTargetContext, setReadyTargetContext] = useState<{
    accountId: string | null
    session: number
  } | null>(null)
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null)
  const [codexBusy, setCodexBusy] = useState(false)
  const [statusFailed, setStatusFailed] = useState(false)
  const [composeSnapshot, setComposeSnapshot] = useState<ReadySnapshot | null>(null)
  const [readSnapshot, setReadSnapshot] = useState<ReadyReadSnapshot | null>(null)
  const [contextStatus, setContextStatus] = useState('')
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [messagesContext, setMessagesContext] = useState('')
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [pendingContext, setPendingContext] = useState('')
  const [cancelError, setCancelError] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState('')
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const activeAccountRef = useRef(activeAccountId)
  const sessionRef = useRef(captureSession)
  const currentTargetKey = useRef('')
  const targetStatusRef = useRef<ComposeTargetStatus>({ status: 'none' })
  const lastCaptureKey = useRef('')
  const captureSequence = useRef(0)
  const pendingRequest = useRef<{ requestId: string; key: string } | null>(null)
  const codexActionRevision = useRef(0)
  const generation = useRef(createAiMailGenerationSequence())
  const fieldMutations = useRef(createAiMailFieldMutationCoordinator(window.api))
  const targetRefresh = useRef(
    createAiMailTargetRefreshCoordinator({
      query: () => window.api.getAiMailComposeTargetStatus()
    })
  )
  const targetReady =
    readyTargetContext?.accountId === activeAccountId &&
    readyTargetContext.session === captureSession
  const target =
    targetReady && targetStatus.status === 'ready' && targetStatus.accountId === activeAccountId
      ? targetStatus
      : null
  const currentReadSnapshot = readSnapshot?.accountId === activeAccountId ? readSnapshot : null
  const currentComposeSnapshot =
    composeSnapshot?.accountId === activeAccountId &&
    target?.composeId === composeSnapshot.composeId
      ? composeSnapshot
      : null
  const contextKey = `${activeAccountId ?? 'none'}:${targetKey(target)}:${currentReadSnapshot?.captureId ?? 'no-read'}:${captureSession}`
  const generationAvailable = GENERATION_ENABLED && codexStatus?.state === 'connected'

  useEffect(() => {
    activeAccountRef.current = activeAccountId
    sessionRef.current = captureSession
  }, [activeAccountId, captureSession])

  const visibleMessages = messagesContext === contextKey ? messages : []
  const requestPending = pending && pendingContext === contextKey

  const captureCurrentContext = useCallback(
    async (force = false): Promise<void> => {
      const sequence = ++captureSequence.current
      const account = activeAccountRef.current
      const session = sessionRef.current
      if (!account) {
        setComposeSnapshot(null)
        setReadSnapshot(null)
        setContextStatus(text.noTarget)
        return
      }
      const currentStatus = targetStatusRef.current
      const activeTarget =
        currentStatus.status === 'ready' && currentStatus.accountId === account
          ? currentStatus
          : null
      const captureKey = `${account}:${activeTarget ? `${activeTarget.accountId}:${activeTarget.composeId}` : ''}:${session}`
      if (!force && captureKey === lastCaptureKey.current && (readSnapshot || composeSnapshot))
        return
      lastCaptureKey.current = captureKey
      setContextStatus(text.loadingSnapshot)
      const [readResult, composeResult] = await Promise.all([
        window.api.getAiMailReadSnapshot().catch(() => ({ status: 'stale' as const })),
        window.api.getAiMailComposeSnapshot().catch(() => ({ status: 'stale' as const }))
      ])
      if (
        sequence !== captureSequence.current ||
        activeAccountRef.current !== account ||
        sessionRef.current !== session
      )
        return
      let nextRead: ReadyReadSnapshot | null = null
      if (readResult.status === 'ready' && readResult.accountId === account) {
        const current = await window.api
          .isAiMailReadSnapshotCurrent(readResult.captureId)
          .catch(() => false)
        if (
          sequence !== captureSequence.current ||
          activeAccountRef.current !== account ||
          sessionRef.current !== session
        )
          return
        if (current) nextRead = readResult
      }
      const nextCompose =
        composeResult.status === 'ready' &&
        activeTarget &&
        composeResult.accountId === account &&
        composeResult.composeId === activeTarget.composeId
          ? composeResult
          : null
      setReadSnapshot(nextRead)
      setComposeSnapshot(nextCompose)
      setContextStatus(nextRead || nextCompose ? '' : text.noTarget)
      setMessages([])
    },
    [composeSnapshot, readSnapshot, text.loadingSnapshot, text.noTarget]
  )

  useEffect(() => {
    const coordinator = targetRefresh.current
    currentTargetKey.current = ''
    let current = true
    const unsubscribeTarget = window.api.onAiMailComposeTarget((status) => {
      if (!current || !coordinator.accept()) return
      setTargetStatus(status)
      targetStatusRef.current = status
      setReadyTargetContext({ accountId: activeAccountId, session: sessionRef.current })
      const nextKey =
        status.status === 'ready' && status.accountId === activeAccountId
          ? `${status.accountId}:${status.composeId}`
          : ''
      if (currentTargetKey.current !== nextKey) {
        const request = pendingRequest.current
        if (request)
          void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
        pendingRequest.current = null
        currentTargetKey.current = nextKey
        setComposeSnapshot(null)
        setMessages([])
        lastCaptureKey.current = ''
      }
    })
    const unsubscribeCodex = window.api.onAiMailCodexStatus(setCodexStatus)
    void window.api.getAiMailCodexStatus().then(
      (status) => {
        if (current) {
          setCodexStatus(status)
          setStatusFailed(false)
        }
      },
      () => {
        if (current) setStatusFailed(true)
      }
    )
    return () => {
      current = false
      captureSequence.current += 1
      const request = pendingRequest.current
      if (request) void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
      unsubscribeTarget()
      unsubscribeCodex()
    }
  }, [activeAccountId])

  useEffect(() => {
    const coordinator = targetRefresh.current
    coordinator.setActive(open)
    if (!open) {
      captureSequence.current += 1
      const request = pendingRequest.current
      if (request) void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
      pendingRequest.current = null
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const refresh = async (): Promise<void> => {
      try {
        const result = await coordinator.query()
        if (result.current) {
          setTargetStatus(result.status)
          targetStatusRef.current = result.status
          setReadyTargetContext({ accountId: activeAccountId, session: captureSession })
          const nextKey =
            result.status.status === 'ready' && result.status.accountId === activeAccountId
              ? `${result.status.accountId}:${result.status.composeId}`
              : ''
          if (nextKey !== currentTargetKey.current) {
            const request = pendingRequest.current
            if (request)
              void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
            pendingRequest.current = null
            currentTargetKey.current = nextKey
            setComposeSnapshot(null)
            setMessages([])
            lastCaptureKey.current = ''
          }
          if (!lastCaptureKey.current) void captureCurrentContext()
        }
      } catch {
        /* bounded refresh retries while open */
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), TARGET_REFRESH_INTERVAL_MS)
      }
    }
    void refresh()
    return () => {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      coordinator.setActive(false)
    }
  }, [open, activeAccountId, captureSession, captureCurrentContext])

  useEffect(() => {
    if (open) closeButtonRef.current?.focus()
  }, [open])

  useEffect(() => {
    lastCaptureKey.current = ''
    const request = pendingRequest.current
    if (request) void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
    pendingRequest.current = null
  }, [activeAccountId, captureSession])

  useEffect(() => {
    const request = pendingRequest.current
    if (!request || request.key === contextKey) return
    void window.api.cancelAiMailGeneration(request.requestId).catch(() => undefined)
    pendingRequest.current = null
  }, [contextKey])

  useEffect(() => {
    if (!open) return
    let active = true
    let timer: ReturnType<typeof setTimeout>
    const check = async (): Promise<void> => {
      const account = activeAccountId
      const session = captureSession
      if (readSnapshot) {
        const valid = await window.api
          .isAiMailReadSnapshotCurrent(readSnapshot.captureId)
          .catch(() => false)
        if (!active) return
        if (!valid) setReadSnapshot(null)
        else {
          timer = setTimeout(() => void check(), TARGET_REFRESH_INTERVAL_MS)
          return
        }
      }
      const result = await window.api
        .getAiMailReadSnapshot()
        .catch(() => ({ status: 'stale' as const }))
      if (!active || activeAccountRef.current !== account || sessionRef.current !== session) return
      if (result.status === 'ready' && result.accountId === account) {
        const valid = await window.api
          .isAiMailReadSnapshotCurrent(result.captureId)
          .catch(() => false)
        if (
          active &&
          valid &&
          activeAccountRef.current === account &&
          sessionRef.current === session
        ) {
          setReadSnapshot(result)
          setContextStatus('')
        }
      }
      if (active) timer = setTimeout(() => void check(), READ_TARGET_REFRESH_INTERVAL_MS)
    }
    timer = setTimeout(
      () => void check(),
      readSnapshot ? TARGET_REFRESH_INTERVAL_MS : READ_TARGET_REFRESH_INTERVAL_MS
    )
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, activeAccountId, captureSession, readSnapshot])

  async function connectCodex(): Promise<void> {
    if (codexBusy) return
    const revision = ++codexActionRevision.current
    setCodexBusy(true)
    try {
      setCodexStatus(await window.api.connectAiMailCodex())
    } catch {
      if (codexActionRevision.current === revision) {
        setStatusFailed(true)
        setCodexStatus({ state: 'error' })
      }
    } finally {
      if (codexActionRevision.current === revision) setCodexBusy(false)
    }
  }

  async function disconnectCodex(): Promise<void> {
    if (codexBusy && codexStatus?.state !== 'connecting') return
    const revision = ++codexActionRevision.current
    setCodexBusy(true)
    try {
      setCodexStatus(await window.api.disconnectAiMailCodex())
    } catch {
      if (codexActionRevision.current === revision) {
        setStatusFailed(true)
        setCodexStatus({ state: 'error' })
      }
    } finally {
      if (codexActionRevision.current === revision) setCodexBusy(false)
    }
  }

  async function runGeneration(userText: string): Promise<void> {
    const account = activeAccountId
    const capturedRead = currentReadSnapshot
    const capturedCompose = currentComposeSnapshot
    const capturedTarget = target
    if (!account || !generationAvailable || requestPending || !userText.trim()) return
    if (!capturedRead && !capturedCompose) return
    const key = contextKey
    const requestId = newId()
    const requestGeneration = generation.current.next(
      `${account}:${targetKey(capturedTarget) || capturedRead?.captureId || 'read'}`
    )
    pendingRequest.current = { requestId, key }
    setPending(true)
    setPendingContext(key)
    setCancelError(false)
    setMessagesContext(key)
    setMessages((current) => [...current, { id: newId(), role: 'user', text: userText }])
    setInstruction('')
    try {
      const outcome = await requestAiMailProposal(
        window.api,
        capturedTarget,
        {
          accountId: account,
          compose: capturedCompose,
          read: capturedRead
        },
        userText,
        requestId,
        requestGeneration
      )
      if (
        pendingRequest.current?.requestId !== requestId ||
        activeAccountRef.current !== account ||
        contextKey !== key
      )
        return
      if (outcome.status === 'ready') {
        if (outcome.output.kind === 'answer')
          setMessages((current) => [
            ...current,
            {
              id: newId(),
              role: 'assistant',
              text:
                outcome.owner === 'none'
                  ? `${outcome.output.text}\n\n${text.replyNeedsCompose}`
                  : outcome.output.text
            }
          ])
        else if (outcome.owner === 'compose' && outcome.snapshot) {
          const proposal: Proposal = {
            snapshot: outcome.snapshot,
            body: { value: outcome.output.text, applied: false, busy: false },
            ...(outcome.output.field === 'subject'
              ? { subject: { value: outcome.output.subject ?? '', applied: false, busy: false } }
              : {})
          }
          setMessages((current) => [
            ...current,
            { id: newId(), role: 'assistant', text: text.proposal, proposal }
          ])
        } else
          setMessages((current) => [
            ...current,
            { id: newId(), role: 'assistant', text: outcome.output.text }
          ])
      } else {
        const failure =
          outcome.status === 'unavailable'
            ? outcome.result.status === 'unsupported'
              ? text.unsupportedTarget
              : outcome.result.status === 'access_locked'
                ? text.lockedTarget
                : text.staleTarget
            : outcome.status === 'failed'
              ? outcome.result.error === 'unauthenticated'
                ? text.unauthenticated
                : outcome.result.error === 'unsupported'
                  ? text.generationUnsupported
                  : outcome.result.error === 'cancelled'
                    ? text.cancelled
                    : text.generationError
              : outcome.status === 'invalid_output'
                ? text.invalidOutput
                : text.staleTarget
        setMessages((current) => [
          ...current,
          {
            id: newId(),
            role: 'assistant',
            text: failure,
            tone:
              outcome.status === 'failed' || outcome.status === 'invalid_output'
                ? 'error'
                : 'notice'
          }
        ])
      }
    } catch {
      if (pendingRequest.current?.requestId === requestId)
        setMessages((current) => [
          ...current,
          { id: newId(), role: 'assistant', text: text.generationError, tone: 'error' }
        ])
    } finally {
      if (pendingRequest.current?.requestId === requestId) {
        pendingRequest.current = null
        setPending(false)
        setPendingContext('')
      }
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (composing.current) return
    const value = instruction.trim()
    if (value) void runGeneration(value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composing.current
    ) {
      event.preventDefault()
      textareaRef.current?.form?.requestSubmit()
    }
  }

  async function cancelGeneration(): Promise<void> {
    const pendingInfo = pendingRequest.current
    if (!pendingInfo) return
    try {
      const result = await window.api.cancelAiMailGeneration(pendingInfo.requestId)
      if (result.cancelled) {
        pendingRequest.current = null
        setPending(false)
        setPendingContext('')
        setMessages((current) => [
          ...current,
          { id: newId(), role: 'assistant', text: text.cancelled, tone: 'notice' }
        ])
      } else setCancelError(true)
    } catch {
      setCancelError(true)
    }
  }

  async function mutateField(
    messageId: string,
    field: 'body' | 'subject',
    operation: 'apply' | 'undo',
    confirmedVersion?: string
  ): Promise<void> {
    const message = messages.find((item) => item.id === messageId)
    const proposal = message?.proposal
    const fieldState = field === 'body' ? proposal?.body : proposal?.subject
    if (
      !proposal ||
      !fieldState ||
      proposal.snapshot.accountId !== activeAccountId ||
      !target ||
      target.composeId !== proposal.snapshot.composeId
    )
      return
    const capturedAccountId = activeAccountId
    const capturedSession = captureSession
    const expectedTargetKey = `${proposal.snapshot.accountId}:${proposal.snapshot.composeId}`
    const setField = (update: (state: FieldState) => FieldState): void =>
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== messageId || !item.proposal) return item
          const state = field === 'body' ? item.proposal.body : item.proposal.subject
          if (!state) return item
          const updated = update(state)
          return { ...item, proposal: { ...item.proposal, [field]: updated } }
        })
      )
    const result = await fieldMutations.current.mutate({
      lockKey: `${messageId}:${field}`,
      snapshot: proposal.snapshot,
      field,
      operation,
      replacement: fieldState.value,
      ...(fieldState.applyId ? { applyId: fieldState.applyId } : {}),
      ...(confirmedVersion ? { confirmedCurrentVersion: confirmedVersion } : {}),
      isCurrent: () =>
        activeAccountRef.current === capturedAccountId &&
        sessionRef.current === capturedSession &&
        currentTargetKey.current === expectedTargetKey,
      onStart: () =>
        setField((state) => ({
          ...state,
          busy: true,
          feedback: undefined,
          lastOperation: operation
        }))
    })
    setField((state) => {
      if (result.status === 'conflict')
        return {
          ...state,
          busy: false,
          feedback: undefined,
          conflict: {
            operation,
            currentVersion: result.currentVersion,
            currentBody: result.currentBody
          }
        }
      if (result.status === 'applied')
        return {
          ...state,
          busy: false,
          applied: true,
          applyId: result.applyId,
          feedback: 'applied',
          conflict: undefined
        }
      if (result.status === 'undone')
        return {
          ...state,
          busy: false,
          applied: false,
          applyId: undefined,
          feedback: 'undone',
          conflict: undefined
        }
      if (result.status === 'busy') return { ...state, busy: true, feedback: 'busy' }
      return {
        ...state,
        busy: false,
        feedback:
          result.status === 'unsupported'
            ? 'unsupported'
            : result.status === 'stale' || result.status === 'stale_target'
              ? 'stale'
              : 'error'
      }
    })
  }

  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      setCopyFeedback(text.copied)
    } catch {
      setCopyFeedback(text.copyError)
    }
  }

  if (!open) return null
  const statusLabel = statusFailed ? text.connectionError : statusText(codexStatus, text)
  const contextDetails = [
    currentReadSnapshot
      ? `${text.receivedEmailChip}: ${currentReadSnapshot.subject || text.newMessage}`
      : '',
    currentComposeSnapshot
      ? `${text.draftChip}: ${currentComposeSnapshot.subject || text.newMessage}`
      : ''
  ].filter(Boolean)
  const header = (
    <>
      <div className="ai-mail-heading">
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
      </div>
      <section className="ai-mail-connection" aria-label={text.codex}>
        <span
          className={`ai-mail-connection-dot ai-mail-state-${codexStatus?.state ?? 'checking'}`}
          aria-hidden="true"
        />
        <div className="ai-mail-connection-copy">
          <strong>{statusLabel}</strong>
          <p>
            {generationAvailable
              ? text.privacy
              : codexStatus?.state === 'connected'
                ? text.generationBlocked
                : text.connectFirst}
          </p>
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
    </>
  )
  const context = (
    <div className="ai-mail-context-chips">
      {contextDetails.map((detail) => (
        <details key={detail} className="ai-mail-captured">
          <summary className="ai-mail-context-chip">
            <strong>{detail}</strong>
          </summary>
          <pre>
            {detail.startsWith(text.receivedEmailChip)
              ? currentReadSnapshot?.body
              : currentComposeSnapshot?.body}
          </pre>
        </details>
      ))}
      {!contextDetails.length && (
        <span className="ai-mail-inline-status" role="status">
          {contextStatus ||
            (targetStatus.status === 'unsupported'
              ? text.unsupportedTarget
              : targetStatus.status === 'access_locked'
                ? text.lockedTarget
                : text.noTarget)}
        </span>
      )}
    </div>
  )
  const composer = (
    <form className="ai-mail-compose" noValidate onSubmit={handleSubmit}>
      <textarea
        ref={textareaRef}
        value={instruction}
        maxLength={2000}
        aria-label={text.requestLabel}
        placeholder={text.requestPlaceholder}
        disabled={
          !generationAvailable ||
          (!currentReadSnapshot && !currentComposeSnapshot) ||
          requestPending
        }
        onChange={(event) => setInstruction(event.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
      />
      <div className="ai-mail-chat-composer-actions">
        <span>
          {!generationAvailable
            ? codexStatus?.state === 'connected'
              ? text.generationBlocked
              : text.connectFirst
            : text.sendContextNotice}
        </span>
        <button
          className="ai-mail-primary"
          type="submit"
          disabled={
            !generationAvailable ||
            (!currentReadSnapshot && !currentComposeSnapshot) ||
            !instruction.trim() ||
            requestPending
          }
        >
          {text.send}
        </button>
      </div>
    </form>
  )
  return (
    <aside className={`ai-mail-panel ai-mail-panel-${layoutMode}`} aria-labelledby="ai-mail-title">
      <AiMailChatLayout header={header} context={context} composer={composer}>
        {visibleMessages.map((message) => (
          <article key={message.id} className={`ai-mail-message ai-mail-message-${message.role}`}>
            <p className={message.tone === 'error' ? 'ai-mail-error' : undefined}>{message.text}</p>
            {message.role === 'assistant' && !message.proposal && (
              <button
                className="ai-mail-text-button"
                type="button"
                onClick={() => void copy(message.text)}
              >
                {text.copy}
              </button>
            )}
            {message.proposal && (
              <div className="ai-mail-proposal">
                {message.proposal.subject && (
                  <label className="ai-mail-suggested-subject">
                    {text.subjectLabel}
                    <input
                      type="text"
                      value={message.proposal.subject.value}
                      disabled={message.proposal.subject.busy}
                      onChange={(event) =>
                        setMessages((current) =>
                          current.map((item) =>
                            item.id === message.id && item.proposal?.subject
                              ? {
                                  ...item,
                                  proposal: {
                                    ...item.proposal,
                                    subject: { ...item.proposal.subject, value: event.target.value }
                                  }
                                }
                              : item
                          )
                        )
                      }
                    />
                  </label>
                )}
                <label>
                  {text.outputLabels.revise}
                  <textarea
                    value={message.proposal.body.value}
                    disabled={message.proposal.body.busy}
                    onChange={(event) =>
                      setMessages((current) =>
                        current.map((item) =>
                          item.id === message.id && item.proposal
                            ? {
                                ...item,
                                proposal: {
                                  ...item.proposal,
                                  body: { ...item.proposal.body, value: event.target.value }
                                }
                              }
                            : item
                        )
                      )
                    }
                  />
                </label>
                {(['subject', 'body'] as const).map((field) => {
                  const state =
                    field === 'body' ? message.proposal?.body : message.proposal?.subject
                  if (!state) return null
                  return (
                    <div key={field} className="ai-mail-proposal-actions">
                      <button
                        className="ai-mail-primary"
                        type="button"
                        disabled={
                          state.busy ||
                          state.applied ||
                          target?.composeId !== message.proposal?.snapshot.composeId
                        }
                        onClick={() => void mutateField(message.id, field, 'apply')}
                      >
                        {state.busy
                          ? text.checking
                          : field === 'subject'
                            ? text.applySubject
                            : text.apply}
                      </button>
                      {state.applied && (
                        <button
                          className="ai-mail-text-button"
                          type="button"
                          disabled={state.busy}
                          onClick={() => void mutateField(message.id, field, 'undo')}
                        >
                          {text.undo}
                        </button>
                      )}
                      <button
                        className="ai-mail-text-button"
                        type="button"
                        onClick={() => void copy(state.value)}
                      >
                        {text.copy}
                      </button>
                      {state.conflict && (
                        <div className="ai-mail-conflict" role="alert">
                          <p>{text.conflictApply}</p>
                          <details>
                            <summary>{text.currentBody}</summary>
                            <pre>{state.conflict.currentBody}</pre>
                          </details>
                          <button
                            type="button"
                            onClick={() =>
                              void mutateField(
                                message.id,
                                field,
                                state.conflict?.operation ?? 'apply',
                                state.conflict?.currentVersion
                              )
                            }
                          >
                            {text.confirmApply}
                          </button>
                        </div>
                      )}
                      {state.feedback && (
                        <p
                          className={
                            ['error', 'stale', 'busy', 'unsupported'].includes(state.feedback)
                              ? 'ai-mail-error'
                              : 'ai-mail-inline-status'
                          }
                          role={
                            ['error', 'stale', 'busy', 'unsupported'].includes(state.feedback)
                              ? 'alert'
                              : 'status'
                          }
                        >
                          {aiMailFieldFeedback(state.feedback, state.lastOperation, text)}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </article>
        ))}
        {requestPending && (
          <div className="ai-mail-pending" role="status">
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
        {copyFeedback && <p role="status">{copyFeedback}</p>}
      </AiMailChatLayout>
    </aside>
  )
}
