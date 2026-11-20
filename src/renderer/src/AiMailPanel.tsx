import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import type {
  AccountViewSnapshot,
  CodexConnectionStatus,
  ComposeSnapshotResult,
  ComposeTargetStatus,
  AiMailComposeMutationResult,
  OllamaConnectionStatus,
  OllamaModel,
  ReadMailSnapshotResult
} from '../../shared/ipc'
import type { AppSettings } from '../../shared/settings'
import type { AppMessages } from './app-messages'
import { AiMailChatLayout } from './AiMailChatLayout'
import { AiMailMarkdown } from './ai-mail-markdown'
import { AppDialog } from './SettingsDialog'
import {
  createAiMailGenerationSequence,
  createAiMailFieldMutationCoordinator,
  createAiMailTargetRefreshCoordinator,
  requestAiMailProposal,
  aiMailFieldFeedback,
  applyAiMailFieldsTogether,
  isAiMailConversationVisible,
  chooseNewestComposeCandidate
} from './ai-mail-panel-flow'

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
  snapshot?: ReadySnapshot
  session: number
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
type ArchivedConversation = {
  id: string
  accountId: string
  title: string
  messages: PanelMessage[]
}
type OverwriteConfirmation =
  | {
      kind: 'conflict'
      messageId: string
      field: 'body' | 'subject'
      operation: 'apply' | 'undo'
      version: string
      currentValue: string
    }
  | { kind: 'overwrite'; messageId: string; field: 'body' | 'subject'; currentValue: string }
  | {
      kind: 'draft'
      messageId: string
      snapshot: ReadySnapshot
      targetLabel: string
      session: number
      includeSubject: boolean
    }

type Props = {
  activeAccountId: string | null
  layoutMode: 'top' | 'bottom' | 'left' | 'right'
  open: boolean
  captureSession: number
  text: AppMessages['aiMail']
  settings: AppSettings | null
  onConfirmationCover: (open: boolean) => Promise<AccountViewSnapshot | null>
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
  settings,
  onConfirmationCover,
  onClose
}: Props): React.JSX.Element | null {
  const [targetStatus, setTargetStatus] = useState<ComposeTargetStatus>({ status: 'none' })
  const [readyTargetContext, setReadyTargetContext] = useState<{
    accountId: string | null
    session: number
  } | null>(null)
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null)
  const [statusFailed, setStatusFailed] = useState(false)
  const [ollamaStatus, setOllamaStatus] = useState<OllamaConnectionStatus | null>(null)
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[] | null>(null)
  const [inventoryFailed, setInventoryFailed] = useState(false)
  const [inventoryLoadedKey, setInventoryLoadedKey] = useState('')
  const [composeSnapshot, setComposeSnapshot] = useState<ReadySnapshot | null>(null)
  const [readSnapshot, setReadSnapshot] = useState<ReadyReadSnapshot | null>(null)
  const [contextStatus, setContextStatus] = useState('')
  const [messages, setMessages] = useState<PanelMessage[]>([])
  const [currentConversationId, setCurrentConversationId] = useState(newId())
  const [messagesAccountId, setMessagesAccountId] = useState<string | null>(null)
  const [archivedConversations, setArchivedConversations] = useState<ArchivedConversation[]>([])
  const archivedConversationsRef = useRef<ArchivedConversation[]>([])
  const [conversationStatus, setConversationStatus] = useState('')
  const [instruction, setInstruction] = useState('')
  const [pending, setPending] = useState(false)
  const [pendingContext, setPendingContext] = useState('')
  const [cancelError, setCancelError] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState('')
  const [confirmOverwrite, setConfirmOverwrite] = useState<OverwriteConfirmation | null>(null)
  const [proposalTargetNotice, setProposalTargetNotice] = useState<{
    messageId: string
    message: string
    kind: 'info' | 'error'
  } | null>(null)
  const [proposalApplyingId, setProposalApplyingId] = useState<string | null>(null)
  const confirmationDialogRef = useRef<HTMLDialogElement | null>(null)
  const confirmationCancelRef = useRef<HTMLButtonElement | null>(null)
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null)
  const confirmationAccountRef = useRef<string | null>(activeAccountId)
  const proposalApplyingRef = useRef(false)
  useEffect(() => {
    proposalApplyingRef.current = proposalApplyingId !== null
  }, [proposalApplyingId])
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
  const requestCancel = useRef<((id: string) => Promise<unknown>) | null>(null)
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
  const provider = settings?.aiMailProvider ?? 'codex'
  const selectedProvider = provider
  const providerRef = useRef(provider)
  const inventoryRequestKey = `${open ? 'open' : 'closed'}:${captureSession}:${settings?.ollamaMode ?? 'local'}:${settings?.ollamaRemoteEndpoint ?? ''}`
  const inventoryLoading = open && inventoryLoadedKey !== inventoryRequestKey
  const selectedModel =
    selectedProvider === 'ollama'
      ? settings?.ollamaMode === 'remote'
        ? settings.ollamaRemoteModel
        : settings?.ollamaModel
      : settings?.codexModel
  const ollamaReady = ollamaStatus?.state === 'available'
  const selectedOllamaAvailable = ollamaModels?.some((model) => model.name === selectedModel)
  // Codex model selection is available, but its mail execution remains fixture-only by policy.
  const generationAvailable =
    provider === 'ollama'
      ? Boolean(
          !inventoryLoading &&
          ollamaStatus?.state === 'available' &&
          (settings?.ollamaMode === 'remote' || ollamaStatus.cloudDisabled) &&
          selectedOllamaAvailable
        )
      : false

  const invalidatePendingGeneration = useCallback((): void => {
    const request = pendingRequest.current
    if (request)
      void (requestCancel.current?.(request.requestId) ?? Promise.resolve()).catch(() => undefined)
    pendingRequest.current = null
    requestCancel.current = null
    void Promise.resolve().then(() => {
      if (!pendingRequest.current) {
        setPending(false)
        setPendingContext('')
        setCancelError(false)
      }
    })
  }, [])

  useEffect(() => {
    activeAccountRef.current = activeAccountId
    sessionRef.current = captureSession
  }, [activeAccountId, captureSession])

  useEffect(() => {
    archivedConversationsRef.current = archivedConversations
  }, [archivedConversations])

  useEffect(() => {
    if (!messagesAccountId || messagesAccountId === activeAccountId) return
    const previousAccountId = messagesAccountId
    const previousMessages = messages
    const title =
      messages.find((message) => message.role === 'user')?.text.slice(0, 72) || text.title
    void Promise.resolve().then(() => {
      if (activeAccountRef.current !== activeAccountId) return
      if (previousMessages.length) {
        setArchivedConversations((current) => [
          {
            id: currentConversationId,
            accountId: previousAccountId,
            title,
            messages: previousMessages
          },
          ...current
        ])
      }
      setMessages([])
      setCurrentConversationId(newId())
      setMessagesAccountId(activeAccountId)
      setConversationStatus('')
    })
  }, [activeAccountId, messagesAccountId, messages, currentConversationId, text.title])

  const visibleMessages = isAiMailConversationVisible(messagesAccountId, activeAccountId)
    ? messages
    : []
  const accountConversations = archivedConversations.filter(
    (conversation) => conversation.accountId === activeAccountId
  )
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
      invalidatePendingGeneration()
    },
    [
      composeSnapshot,
      readSnapshot,
      text.loadingSnapshot,
      text.noTarget,
      invalidatePendingGeneration
    ]
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
        invalidatePendingGeneration()
        currentTargetKey.current = nextKey
        setComposeSnapshot(null)
        setConfirmOverwrite(null)
        lastCaptureKey.current = ''
      }
    })
    const unsubscribeCodex = window.api.onAiMailCodexStatus((status) => {
      if (current) setCodexStatus(status)
    })
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
      if (request) {
        const cancel =
          providerRef.current === 'ollama'
            ? (id: string) => window.api.cancelAiMailOllamaGeneration(id)
            : (id: string) => window.api.cancelAiMailGeneration(id)
        void cancel(request.requestId).catch(() => undefined)
      }
      unsubscribeTarget()
      unsubscribeCodex()
    }
  }, [activeAccountId, invalidatePendingGeneration])

  useEffect(() => {
    const coordinator = targetRefresh.current
    coordinator.setActive(open)
    if (!open) {
      captureSequence.current += 1
      invalidatePendingGeneration()
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
            invalidatePendingGeneration()
            currentTargetKey.current = nextKey
            setComposeSnapshot(null)
            setConfirmOverwrite(null)
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
  }, [open, activeAccountId, captureSession, captureCurrentContext, invalidatePendingGeneration])

  useEffect(() => {
    if (!open) return
    lastCaptureKey.current = ''
    invalidatePendingGeneration()
  }, [activeAccountId, captureSession, open, invalidatePendingGeneration])

  useEffect(() => {
    const request = pendingRequest.current
    if (!request || request.key === contextKey) return
    invalidatePendingGeneration()
  }, [contextKey, open, invalidatePendingGeneration])

  useEffect(() => {
    providerRef.current = provider
  }, [provider])

  useEffect(() => {
    if (!open) return
    let current = true
    void Promise.allSettled([window.api.getOllamaStatus(), window.api.getOllamaModels()]).then(
      (results) => {
        if (!current) return
        if (results[0].status === 'fulfilled') setOllamaStatus(results[0].value)
        else setOllamaStatus({ state: 'unavailable', cloudDisabled: false })
        if (results[1].status === 'fulfilled') setOllamaModels(results[1].value)
        else setOllamaModels([])
        setInventoryFailed(results.some((result) => result.status === 'rejected'))
        setInventoryLoadedKey(inventoryRequestKey)
      }
    )
    return () => {
      current = false
    }
  }, [
    open,
    captureSession,
    settings?.ollamaMode,
    settings?.ollamaRemoteEndpoint,
    inventoryRequestKey
  ])

  useEffect(() => {
    const request = pendingRequest.current
    if (!request) return
    invalidatePendingGeneration()
  }, [provider, selectedModel, invalidatePendingGeneration])

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

  async function runGeneration(userText: string): Promise<void> {
    const account = activeAccountId
    const conversationId = currentConversationId
    const capturedRead = currentReadSnapshot
    const capturedCompose = currentComposeSnapshot
    const capturedTarget = target
    if (!account || !generationAvailable || requestPending || !userText.trim()) return
    const key = contextKey
    const requestId = newId()
    const requestGeneration = generation.current.next(
      `${account}:${targetKey(capturedTarget) || capturedRead?.captureId || 'read'}`
    )
    pendingRequest.current = { requestId, key }
    requestCancel.current =
      provider === 'ollama'
        ? (id) => window.api.cancelAiMailOllamaGeneration(id)
        : (id) => window.api.cancelAiMailGeneration(id)
    setPending(true)
    setPendingContext(key)
    setCancelError(false)
    setMessagesAccountId(account)
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
        requestGeneration,
        provider,
        undefined,
        conversationId
      )
      if (
        pendingRequest.current?.requestId !== requestId ||
        activeAccountRef.current !== account ||
        sessionRef.current !== captureSession ||
        providerRef.current !== provider
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
                outcome.owner === 'none' && outcome.readSnapshot && outcome.output.kind === 'answer'
                  ? `${outcome.output.text}\n\n${text.replyNeedsCompose}`
                  : outcome.output.kind === 'answer'
                    ? outcome.output.text
                    : text.proposal
            }
          ])
        else if (outcome.output.kind === 'proposal') {
          const proposal: Proposal = {
            ...(outcome.snapshot ? { snapshot: outcome.snapshot } : {}),
            session: captureSession,
            body: { value: outcome.output.body, applied: false, busy: false },
            subject: { value: outcome.output.subject, applied: false, busy: false }
          }
          setMessages((current) => [
            ...current,
            {
              id: newId(),
              role: 'assistant',
              text: outcome.owner === 'compose' ? text.proposal : text.replyNeedsCompose,
              proposal
            }
          ])
        }
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
        requestCancel.current = null
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

  function startNewConversation(): void {
    invalidatePendingGeneration()
    if (activeAccountId && messages.length) {
      setArchivedConversations((current) => [
        {
          id: currentConversationId,
          accountId: activeAccountId,
          title:
            messages.find((message) => message.role === 'user')?.text.slice(0, 72) || text.title,
          messages
        },
        ...current
      ])
    }
    setMessages([])
    setCurrentConversationId(newId())
    setMessagesAccountId(activeAccountId)
    setInstruction('')
    setConversationStatus('')
  }

  function restoreConversation(conversationId: string): void {
    const archived = accountConversations.find((conversation) => conversation.id === conversationId)
    const currentArchive = archivedConversationsRef.current.find(
      (conversation) => conversation.id === conversationId
    )
    if (
      !archived ||
      archived.accountId !== activeAccountId ||
      !currentArchive ||
      currentArchive.accountId !== activeAccountId ||
      activeAccountRef.current !== activeAccountId
    ) {
      setConversationStatus(text.conversationUnavailable)
      return
    }
    invalidatePendingGeneration()
    const currentConversation =
      activeAccountId && messages.length
        ? {
            id: currentConversationId,
            accountId: activeAccountId,
            title:
              messages.find((message) => message.role === 'user')?.text.slice(0, 72) || text.title,
            messages
          }
        : null
    setArchivedConversations((current) => [
      ...(currentConversation ? [currentConversation] : []),
      ...current.filter((conversation) => conversation.id !== conversationId)
    ])
    setMessages(archived.messages)
    setMessagesAccountId(archived.accountId)
    setCurrentConversationId(archived.id)
    setInstruction('')
    setConversationStatus(text.conversationRestored)
  }

  async function chooseProposalTarget(
    messageId: string,
    requestedComposeId?: string
  ): Promise<void> {
    const proposalMessage = messages.find((message) => message.id === messageId)
    const proposal = proposalMessage?.proposal
    const accountId = activeAccountId
    const session = captureSession
    if (!proposal || !accountId || proposal.session !== session || proposalApplyingId) return
    setProposalApplyingId(messageId)
    setProposalTargetNotice(null)
    try {
      const refreshed = await window.api.getAiMailComposeTargetStatus()
      if (activeAccountRef.current !== accountId || sessionRef.current !== session) return
      setTargetStatus(refreshed)
      targetStatusRef.current = refreshed
      setReadyTargetContext({ accountId, session })
      const candidates = 'candidates' in refreshed ? (refreshed.candidates ?? []) : []
      let composeId = requestedComposeId
      if (!composeId) composeId = chooseNewestComposeCandidate(candidates) ?? ''
      if (!composeId) {
        setProposalTargetNotice({
          messageId,
          message: candidates.length > 1 ? text.chooseDraftFirst : text.noComposeForApply,
          kind: 'info'
        })
        return
      }
      const candidate = candidates.find((item) => item.composeId === composeId)
      const currentTargetIsAllowed =
        refreshed.status === 'ready' &&
        refreshed.accountId === accountId &&
        refreshed.composeId === composeId
      if (!candidate && !currentTargetIsAllowed) {
        setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
        return
      }
      if (requestedComposeId && !candidate) {
        setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
        return
      }
      const result = await window.api.selectAiMailComposeTarget({ accountId, composeId })
      if (
        activeAccountRef.current !== accountId ||
        sessionRef.current !== session ||
        result.status !== 'ready' ||
        result.accountId !== accountId ||
        result.composeId !== composeId
      ) {
        setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
        return
      }
      currentTargetKey.current = `${accountId}:${composeId}`
      setComposeSnapshot(result)
      setConfirmOverwrite({
        kind: 'draft',
        messageId,
        snapshot: result,
        targetLabel:
          candidate?.label ??
          (refreshed.status === 'ready' ? refreshed.accountLabel : text.newMessage),
        session,
        includeSubject: Boolean(proposal.subject)
      })
    } catch {
      setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
    } finally {
      setProposalApplyingId(null)
    }
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
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
      const result = (await (requestCancel.current?.(pendingInfo.requestId) ??
        Promise.resolve({ cancelled: false }))) as { cancelled: boolean }
      if (result.cancelled) {
        pendingRequest.current = null
        requestCancel.current = null
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

  const hasConfirmation = confirmOverwrite !== null
  const confirmationMessageId = confirmOverwrite?.messageId
  useEffect(() => {
    if (!hasConfirmation) {
      confirmationAccountRef.current = activeAccountId
      return
    }
    if (confirmationAccountRef.current !== activeAccountId) setConfirmOverwrite(null)
  }, [activeAccountId, hasConfirmation])

  useEffect(() => {
    if (!hasConfirmation) return
    if (confirmationAccountRef.current !== activeAccountId) {
      setConfirmOverwrite(null)
      return
    }
    let active = true
    const dialog = confirmationDialogRef.current
    const activeElement = document.activeElement
    confirmationReturnFocusRef.current =
      activeElement instanceof HTMLElement ? activeElement : closeButtonRef.current
    void onConfirmationCover(true)
      .then(
        async (snapshot) => {
          if (activeAccountId && snapshot?.accountId !== activeAccountId)
            throw new Error('Unable to capture the active Gmail view')
          if (snapshot) {
            const image = new Image()
            image.src = snapshot.dataUrl
            try {
              await image.decode()
            } catch {
              throw new Error('Unable to display the captured Gmail view')
            }
          }
          if (!active) {
            await onConfirmationCover(false)
            return
          }
          dialog?.showModal()
          confirmationCancelRef.current?.focus()
        },
        () => {
          if (active) {
            setProposalTargetNotice({
              messageId: confirmationMessageId ?? '',
              message: text.modalCoverError,
              kind: 'error'
            })
            setConfirmOverwrite(null)
          }
        }
      )
      .catch(() => {
        if (active) {
          void onConfirmationCover(false)
          setProposalTargetNotice({
            messageId: confirmationMessageId ?? '',
            message: text.modalCoverError,
            kind: 'error'
          })
          setConfirmOverwrite(null)
        }
      })
    return () => {
      active = false
      if (dialog?.open) dialog.close()
      void onConfirmationCover(false)
      confirmationReturnFocusRef.current?.focus()
      confirmationReturnFocusRef.current = null
    }
  }, [
    activeAccountId,
    confirmationMessageId,
    hasConfirmation,
    onConfirmationCover,
    text.modalCoverError
  ])

  useEffect(() => {
    const resizeProposalBodies = (): void => {
      if (typeof document === 'undefined') return
      for (const textarea of document.querySelectorAll<HTMLTextAreaElement>(
        '.ai-mail-proposal textarea'
      )) {
        textarea.style.height = 'auto'
        textarea.style.height = `${textarea.scrollHeight}px`
      }
    }
    resizeProposalBodies()
    window.addEventListener('resize', resizeProposalBodies)
    return () => window.removeEventListener('resize', resizeProposalBodies)
  }, [messages])

  async function mutateField(
    messageId: string,
    field: 'body' | 'subject',
    operation: 'apply' | 'undo',
    confirmedVersion?: string
  ): Promise<void> {
    await mutateFieldResult(messageId, field, operation, confirmedVersion)
  }

  async function undoAppliedProposal(messageId: string): Promise<void> {
    const proposal = messages.find((message) => message.id === messageId)?.proposal
    if (!proposal) return
    const fields: Array<'body' | 'subject'> = []
    if (proposal.body.applied) fields.push('body')
    if (proposal.subject?.applied) fields.push('subject')
    for (const field of fields) {
      const result = await mutateFieldResult(messageId, field, 'undo')
      if (
        result.status === 'confirmation_required' ||
        result.status === 'conflict' ||
        result.status === 'stale' ||
        result.status === 'stale_target'
      )
        break
    }
  }

  async function mutateFieldResult(
    messageId: string,
    field: 'body' | 'subject',
    operation: 'apply' | 'undo',
    confirmedVersion?: string,
    applyIdOverride?: string,
    allowOverwrite = false
  ): Promise<
    | AiMailComposeMutationResult
    | { status: 'stale' | 'unsupported' | 'error' | 'confirmation_required' }
  > {
    const message = messages.find((item) => item.id === messageId)
    const proposal = message?.proposal
    const fieldState = field === 'body' ? proposal?.body : proposal?.subject
    if (
      !proposal ||
      !fieldState ||
      !proposal.snapshot ||
      proposal.snapshot.accountId !== activeAccountId ||
      proposal.session !== captureSession ||
      !target ||
      target.composeId !== proposal.snapshot.composeId
    ) {
      setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
      return { status: 'stale' }
    }
    const capturedAccountId = activeAccountId
    const capturedSession = captureSession
    const expectedTargetKey = `${proposal.snapshot.accountId}:${proposal.snapshot.composeId}`
    if (operation === 'apply' && !allowOverwrite) {
      const current = await window.api
        .getAiMailComposeSnapshot()
        .catch(() => ({ status: 'stale' as const }))
      if (
        current.status !== 'ready' ||
        current.accountId !== capturedAccountId ||
        current.composeId !== proposal.snapshot.composeId ||
        activeAccountRef.current !== capturedAccountId ||
        sessionRef.current !== capturedSession ||
        currentTargetKey.current !== expectedTargetKey
      )
        return { status: 'stale' }
      const currentValue = field === 'subject' ? current.subject : current.body
      if (currentValue && currentValue !== fieldState.value) {
        setConfirmOverwrite({ kind: 'overwrite', messageId, field, currentValue })
        return { status: 'confirmation_required' }
      }
    }
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
      ...((applyIdOverride ?? fieldState.applyId)
        ? { applyId: applyIdOverride ?? fieldState.applyId }
        : {}),
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
      if (result.status === 'conflict') {
        setConfirmOverwrite({
          kind: 'conflict',
          messageId,
          field,
          operation,
          version: result.currentVersion,
          currentValue: result.currentBody
        })
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
    return result
  }

  async function copy(value: string): Promise<void> {
    try {
      await window.api.writeClipboardText(value)
      setCopyFeedback(text.copied)
    } catch {
      setCopyFeedback(text.copyError)
    }
  }

  function confirmApply(): void {
    const confirmation = confirmOverwrite
    if (!confirmation) return
    if (confirmation.kind === 'draft') {
      void applyProposalDraft(confirmation)
      return
    }
    setConfirmOverwrite(null)
    if (confirmation.kind === 'overwrite') {
      void mutateFieldResult(
        confirmation.messageId,
        confirmation.field,
        'apply',
        undefined,
        undefined,
        true
      )
      return
    }
    void mutateField(
      confirmation.messageId,
      confirmation.field,
      confirmation.operation,
      confirmation.version
    )
  }

  async function applyProposalDraft(
    confirmation: Extract<OverwriteConfirmation, { kind: 'draft' }>
  ): Promise<void> {
    const { snapshot, session, messageId, includeSubject } = confirmation
    const proposal = messages.find((message) => message.id === messageId)?.proposal
    const isCurrent = (): boolean =>
      activeAccountRef.current === snapshot.accountId &&
      sessionRef.current === session &&
      currentTargetKey.current === `${snapshot.accountId}:${snapshot.composeId}`
    if (!proposal || !isCurrent()) {
      setConfirmOverwrite(null)
      setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
      return
    }
    setProposalApplyingId(messageId)
    try {
      const latest = await window.api.getAiMailComposeSnapshot()
      if (
        !isCurrent() ||
        latest.status !== 'ready' ||
        latest.accountId !== snapshot.accountId ||
        latest.composeId !== snapshot.composeId ||
        latest.documentVersion !== snapshot.documentVersion ||
        latest.subject !== snapshot.subject ||
        latest.body !== snapshot.body
      ) {
        setConfirmOverwrite(null)
        setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
        return
      }
      const request = {
        accountId: snapshot.accountId,
        composeId: snapshot.composeId,
        documentVersion: snapshot.documentVersion,
        snapshotId: snapshot.snapshotId
      }
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  snapshot,
                  body: { ...message.proposal.body, busy: true, feedback: undefined },
                  ...(includeSubject && message.proposal.subject
                    ? { subject: { ...message.proposal.subject, busy: true, feedback: undefined } }
                    : {})
                }
              }
            : message
        )
      )
      let bodyResult: AiMailComposeMutationResult
      let subjectApplyId: string | undefined
      if (includeSubject && proposal.subject) {
        const combined = await applyAiMailFieldsTogether<AiMailComposeMutationResult>(
          async (): Promise<AiMailComposeMutationResult> => {
            if (!isCurrent()) return { status: 'stale_target' }
            return await window.api.applyAiMailSubject({
              ...request,
              replacement: proposal.subject?.value ?? ''
            })
          },
          async (): Promise<AiMailComposeMutationResult> => {
            if (!isCurrent()) return { status: 'stale_target' }
            return await window.api.applyAiMailDraft({
              ...request,
              replacement: proposal.body.value
            })
          },
          async (applyId): Promise<AiMailComposeMutationResult> => {
            if (!isCurrent()) return { status: 'stale_target' }
            return await window.api.undoAiMailSubject({ ...request, applyId })
          }
        )
        if (
          combined.status === 'applied' &&
          combined.subject.status === 'applied' &&
          combined.body?.status === 'applied'
        ) {
          bodyResult = combined.body
          subjectApplyId = combined.subject.applyId
        } else {
          const failedStatus =
            combined.status === 'partial'
              ? text.applyPartial
              : combined.status === 'rolled_back'
                ? text.applyRolledBack
                : text.applyFailed
          setConfirmOverwrite(null)
          setProposalTargetNotice({ messageId, message: failedStatus, kind: 'error' })
          setMessages((current) =>
            current.map((message) =>
              message.id === messageId && message.proposal
                ? {
                    ...message,
                    proposal: {
                      ...message.proposal,
                      body: {
                        ...message.proposal.body,
                        busy: false,
                        feedback: undefined
                      },
                      ...(message.proposal.subject
                        ? {
                            subject:
                              combined.status === 'partial' &&
                              combined.subject.status === 'applied' &&
                              combined.subject.applyId
                                ? {
                                    ...message.proposal.subject,
                                    applied: true,
                                    applyId: combined.subject.applyId,
                                    busy: false,
                                    feedback: undefined,
                                    lastOperation: 'apply'
                                  }
                                : {
                                    ...message.proposal.subject,
                                    busy: false,
                                    feedback: undefined
                                  }
                          }
                        : {})
                    }
                  }
                : message
            )
          )
          return
        }
      } else {
        if (!isCurrent()) {
          setConfirmOverwrite(null)
          setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
          return
        }
        bodyResult = await window.api.applyAiMailDraft({
          ...request,
          replacement: proposal.body.value
        })
      }
      if (bodyResult.status !== 'applied') {
        setConfirmOverwrite(null)
        setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
        return
      }
      setConfirmOverwrite(null)
      setProposalTargetNotice(null)
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  snapshot,
                  body: {
                    ...message.proposal.body,
                    applied: true,
                    applyId: bodyResult.applyId,
                    busy: false,
                    feedback: 'applied'
                  },
                  ...(subjectApplyId && message.proposal.subject
                    ? {
                        subject: {
                          ...message.proposal.subject,
                          applied: true,
                          applyId: subjectApplyId,
                          busy: false,
                          feedback: 'applied'
                        }
                      }
                    : {})
                }
              }
            : message
        )
      )
    } catch {
      setConfirmOverwrite(null)
      setProposalTargetNotice({ messageId, message: text.staleTarget, kind: 'error' })
    } finally {
      setProposalApplyingId(null)
      setMessages((current) =>
        current.map((message) =>
          message.id === messageId && message.proposal
            ? {
                ...message,
                proposal: {
                  ...message.proposal,
                  body: { ...message.proposal.body, busy: false },
                  ...(message.proposal.subject
                    ? { subject: { ...message.proposal.subject, busy: false } }
                    : {})
                }
              }
            : message
        )
      )
    }
  }

  if (!open) return null
  const targetCandidates =
    targetStatus.status === 'ready' && targetStatus.accountId !== activeAccountId
      ? []
      : 'candidates' in targetStatus
        ? (targetStatus.candidates ?? [])
        : []
  const visibleCandidates = [...targetCandidates]
  if (target && !visibleCandidates.some((candidate) => candidate.composeId === target.composeId))
    visibleCandidates.unshift({
      composeId: target.composeId,
      label: target.accountLabel,
      lastUsedAt: 0
    })
  const statusLabel =
    selectedProvider === 'ollama'
      ? inventoryLoading
        ? text.providerLoading
        : inventoryFailed
          ? text.providerError
          : !ollamaReady
            ? text.ollamaUnavailable
            : !selectedModel
              ? text.chooseModel
              : !selectedOllamaAvailable
                ? text.modelUnavailable
                : text.ollamaReady
      : statusFailed
        ? text.connectionError
        : statusText(codexStatus, text)
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
        <button className="ai-mail-text-button" type="button" onClick={startNewConversation}>
          {text.newConversation}
        </button>
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
    </>
  )
  const context = (
    <div className="ai-mail-context-chips">
      {accountConversations.length > 0 && (
        <label className="ai-mail-history-picker">
          <span>{text.earlierConversations}</span>
          <select
            aria-label={text.earlierConversations}
            value=""
            onChange={(event) => restoreConversation(event.target.value)}
          >
            <option value="">{text.chooseConversation}</option>
            {accountConversations.map((conversation) => (
              <option key={conversation.id} value={conversation.id}>
                {conversation.title}
              </option>
            ))}
          </select>
        </label>
      )}
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
      {conversationStatus && (
        <span className="ai-mail-conversation-status" role="status">
          {conversationStatus}
        </span>
      )}
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
        className="resize-none"
        ref={textareaRef}
        value={instruction}
        maxLength={2000}
        aria-label={text.requestLabel}
        placeholder={text.requestPlaceholder}
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
        <span className="ai-mail-data-sharing">
          {!generationAvailable
            ? provider === 'codex'
              ? text.codexGenerationUnavailable
              : statusLabel
            : text.sendContextNotice}
        </span>
        <button
          className="ai-mail-primary"
          type="submit"
          disabled={
            !generationAvailable || !activeAccountId || !instruction.trim() || requestPending
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
            {message.role === 'assistant' ? (
              <AiMailMarkdown text={message.text} tone={message.tone} />
            ) : (
              <p className={message.tone === 'error' ? 'ai-mail-error' : undefined}>
                {message.text}
              </p>
            )}
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
                    className="resize-none"
                    value={message.proposal.body.value}
                    disabled={message.proposal.body.busy}
                    onInput={(event) => {
                      const textarea = event.currentTarget
                      textarea.style.height = 'auto'
                      textarea.style.height = `${textarea.scrollHeight}px`
                    }}
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
                {(() => {
                  const fields = [message.proposal.subject, message.proposal.body].filter(
                    (state): state is FieldState => state !== undefined
                  )
                  const appliedFields = fields.filter((state) => state.applied)
                  const feedbackState =
                    fields.find((state) =>
                      ['error', 'stale', 'busy', 'unsupported'].includes(state.feedback ?? '')
                    ) ?? fields.find((state) => state.feedback)
                  const hasFeedbackError = Boolean(
                    feedbackState &&
                    ['error', 'stale', 'busy', 'unsupported'].includes(feedbackState.feedback ?? '')
                  )
                  const targetNotice =
                    proposalTargetNotice?.messageId === message.id ? proposalTargetNotice : null
                  const operationMessage = feedbackState?.feedback
                    ? hasFeedbackError &&
                      feedbackState.lastOperation === 'undo' &&
                      appliedFields.length > 0
                      ? text.undoPartial
                      : aiMailFieldFeedback(
                          feedbackState.feedback,
                          feedbackState.lastOperation,
                          text
                        )
                    : appliedFields.length > 0
                      ? text.applied
                      : ''
                  const statusMessage =
                    targetNotice?.kind === 'error'
                      ? targetNotice.message
                      : operationMessage ||
                        targetNotice?.message ||
                        (message.proposal.session !== captureSession
                          ? text.draftSessionExpired
                          : visibleCandidates.length === 0
                            ? text.noComposeForApply
                            : visibleCandidates.length > 1 && !target
                              ? text.chooseDraftFirst
                              : text.draftReady)
                  const missingDefaultTarget = visibleCandidates.length > 1 && !target
                  const statusIsError =
                    targetNotice?.kind === 'error' || (Boolean(feedbackState) && hasFeedbackError)
                  const copiedValue = message.proposal.subject
                    ? `${message.proposal.subject.value}\n\n${message.proposal.body.value}`
                    : message.proposal.body.value

                  return (
                    <div className="ai-mail-proposal-footer">
                      <p
                        className={statusIsError ? 'ai-mail-error' : 'ai-mail-inline-status'}
                        role={statusIsError ? 'alert' : 'status'}
                      >
                        {statusMessage}
                      </p>
                      <div
                        className="ai-mail-proposal-actions"
                        role="group"
                        aria-label={text.draftActions}
                      >
                        <button
                          className="ai-mail-primary"
                          type="button"
                          disabled={
                            message.proposal.session !== captureSession ||
                            proposalApplyingId === message.id ||
                            missingDefaultTarget
                          }
                          onClick={() => void chooseProposalTarget(message.id)}
                        >
                          {proposalApplyingId === message.id
                            ? text.checking
                            : visibleCandidates.length === 0
                              ? text.findDraft
                              : text.reviewDraft}
                        </button>
                        {visibleCandidates.length > 1 && (
                          <select
                            className="ai-mail-target-menu"
                            aria-label={text.chooseDraft}
                            value=""
                            disabled={
                              message.proposal.session !== captureSession ||
                              proposalApplyingId === message.id
                            }
                            onChange={(event) => {
                              if (event.target.value)
                                void chooseProposalTarget(message.id, event.target.value)
                            }}
                          >
                            <option value="">{text.chooseDraft}</option>
                            {visibleCandidates.map((candidate) => (
                              <option key={candidate.composeId} value={candidate.composeId}>
                                {candidate.label}
                              </option>
                            ))}
                          </select>
                        )}
                        {appliedFields.length > 0 && (
                          <button
                            className="ai-mail-text-button"
                            type="button"
                            disabled={fields.some((state) => state.busy)}
                            onClick={() => void undoAppliedProposal(message.id)}
                          >
                            {text.undo}
                          </button>
                        )}
                        <button
                          className="ai-mail-text-button"
                          type="button"
                          onClick={() => void copy(copiedValue)}
                        >
                          {text.copy}
                        </button>
                      </div>
                    </div>
                  )
                })()}
              </div>
            )}
          </article>
        ))}
        {requestPending && (
          <div className="ai-mail-pending" role="status">
            <span>{text.thinking}</span>
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
        {copyFeedback && (
          <p className="ai-mail-copy-feedback" role="status">
            {copyFeedback}
          </p>
        )}
      </AiMailChatLayout>
      {confirmOverwrite && (
        <AppDialog
          dialogRef={confirmationDialogRef}
          className="app-dialog ai-mail-confirm-dialog"
          ariaLabelledBy="ai-mail-confirm-title"
          role="alertdialog"
          onCancel={() => {
            if (!proposalApplyingRef.current) setConfirmOverwrite(null)
          }}
        >
          <div className="ai-mail-confirm-content">
            <h2 id="ai-mail-confirm-title">
              {confirmOverwrite.kind === 'draft' ? text.reviewDraftTitle : text.overwriteTitle}
            </h2>
            {confirmOverwrite.kind === 'draft' ? (
              <div className="ai-mail-apply-review">
                <p>
                  {text.applyTargetLabel}: {confirmOverwrite.targetLabel}
                </p>
                <p>{text.applyReviewMessage}</p>
                <fieldset>
                  <legend>{text.applyScopeLabel}</legend>
                  {confirmOverwrite.snapshot.subject !== undefined && (
                    <label>
                      <input
                        type="radio"
                        name="ai-mail-apply-scope"
                        checked={confirmOverwrite.includeSubject}
                        onChange={() =>
                          setConfirmOverwrite({ ...confirmOverwrite, includeSubject: true })
                        }
                      />
                      {text.applyBothFields}
                    </label>
                  )}
                  <label>
                    <input
                      type="radio"
                      name="ai-mail-apply-scope"
                      checked={!confirmOverwrite.includeSubject}
                      onChange={() =>
                        setConfirmOverwrite({ ...confirmOverwrite, includeSubject: false })
                      }
                    />
                    {text.applyBodyOnly}
                  </label>
                </fieldset>
                <section>
                  <h3>{text.subjectLabel}</h3>
                  {confirmOverwrite.includeSubject ? (
                    <>
                      <div className="ai-mail-review-column">
                        <p>{text.currentValueLabel}</p>
                        <pre>{confirmOverwrite.snapshot.subject || text.emptyValue}</pre>
                      </div>
                      <div className="ai-mail-review-column">
                        <p>{text.proposedValueLabel}</p>
                        <pre className="ai-mail-review-proposed">
                          {messages.find((item) => item.id === confirmOverwrite.messageId)?.proposal
                            ?.subject?.value ?? ''}
                        </pre>
                      </div>
                    </>
                  ) : (
                    <p>
                      {text.keepSubjectMessage}:{' '}
                      {confirmOverwrite.snapshot.subject || text.emptyValue}
                    </p>
                  )}
                </section>
                <section>
                  <h3>{text.outputLabels.revise}</h3>
                  <div className="ai-mail-review-column">
                    <p>{text.currentValueLabel}</p>
                    <pre>{confirmOverwrite.snapshot.body || text.emptyValue}</pre>
                  </div>
                  <div className="ai-mail-review-column">
                    <p>{text.proposedValueLabel}</p>
                    <pre className="ai-mail-review-proposed">
                      {messages.find((item) => item.id === confirmOverwrite.messageId)?.proposal
                        ?.body.value ?? ''}
                    </pre>
                  </div>
                </section>
              </div>
            ) : (
              <>
                <p>
                  {confirmOverwrite.kind === 'conflict'
                    ? text.overwriteMessage
                    : text.overwriteMessage}
                </p>
                <pre>{confirmOverwrite.currentValue}</pre>
              </>
            )}
            <div className="ai-mail-confirm-actions">
              <button
                ref={confirmationCancelRef}
                autoFocus
                type="button"
                className="ai-mail-text-button"
                disabled={proposalApplyingId !== null}
                onClick={() => setConfirmOverwrite(null)}
              >
                {text.cancelOverwrite}
              </button>
              <button
                type="button"
                className="ai-mail-primary"
                onClick={confirmApply}
                disabled={proposalApplyingId !== null}
              >
                {confirmOverwrite.kind === 'draft' ? text.applyDraft : text.confirmApply}
              </button>
            </div>
          </div>
        </AppDialog>
      )}
    </aside>
  )
}
