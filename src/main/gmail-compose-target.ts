import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  AccountAccessState,
  AiMailComposeApplyRequest,
  AiMailComposeMutationResult,
  AiMailComposeUndoRequest,
  ComposeSnapshotResult,
  ComposeTargetStatus
} from '../shared/ipc'
import type { createAccountAccessController } from './account-access-controller'
import type { createAccountViewManager } from './account-view-manager'

const WORLD_ID = 7913
const MAX_BODY_LENGTH = 20_000
const MAX_SUBJECT_LENGTH = 998
const MAX_RECIPIENTS = 20
const MAX_RECIPIENT_LENGTH = 320

type Views = ReturnType<typeof createAccountViewManager>
type Access = ReturnType<typeof createAccountAccessController>
type Account = { id: string; email?: string | null; displayName?: string | null }

interface Context {
  accountId: string
  contents: WebContents
  lifecycleVersion: string
  documentVersion: string
}

interface PageResult {
  targetId: string | null
  unsupported?: boolean
  snapshot: {
    subject: string
    recipients: string[]
    body: string
    supported: boolean
  } | null
}

interface PageReplaceResult {
  status: 'applied' | 'conflict' | 'unsupported' | 'stale_target'
  body?: string
}

interface ComposeLease {
  generation: number
  accountId: string
  composeId: string
  targetId: string
  contents: WebContents
  lifecycleVersion: string
  documentVersion: string
  probeDocumentId: string
}

export function gmailComposeTargetPageSource(documentId: string): string {
  return `(() => {
    const key = '__hantongComposeTarget';
    const documentId = ${JSON.stringify(documentId)};
    if (globalThis[key]?.documentId === documentId) return true;
    globalThis[key]?.revoke?.();
    const ids = new WeakMap();
    const targets = new Map();
    let sequence = 0;
    let selected = null;
    const candidateFor = (node) => {
      if (!(node instanceof Element)) return null;
      const editor = node.matches('[contenteditable="true"]') ? node : node.closest('[contenteditable="true"]');
      let root = editor || node;
      for (let depth = 0; root && depth < 12; depth += 1, root = root.parentElement) {
        const editors = Array.from(root.querySelectorAll('[contenteditable="true"]'));
        const subjects = Array.from(root.querySelectorAll('input[name="subjectbox"]'));
        if (editors.length !== 1 || (editor && editors[0] !== editor) || subjects.length > 1) continue;
        if (subjects.length === 1 && subjects[0] instanceof HTMLInputElement) return { root, editor: editors[0], subject: subjects[0] };
        const replyMarker = root.querySelector('button[aria-label*="Reply"], [role="button"][aria-label*="Reply"], button[data-tooltip*="Reply"], [role="button"][data-tooltip*="Reply"], button[aria-label*="답장"], [role="button"][aria-label*="답장"], button[data-tooltip*="답장"], [role="button"][data-tooltip*="답장"]');
        if (replyMarker) {
          let editorBranch = editors[0];
          while (editorBranch && editorBranch.parentElement !== root) editorBranch = editorBranch.parentElement;
          let markerBranch = replyMarker;
          while (markerBranch && markerBranch.parentElement !== root) markerBranch = markerBranch.parentElement;
          if (editorBranch && editorBranch === markerBranch) return { root, editor: editors[0], subject: null };
        }
      }
      return null;
    };
    const remember = (event) => {
      const item = candidateFor(event.target);
      if (!item) {
        const node = event.target;
        if (node instanceof Element && (node.matches('[contenteditable="true"]') || node.closest('[contenteditable="true"]'))) selected = 'unsupported';
        return;
      }
      let id = ids.get(item.editor);
      if (!id) {
        id = 'target-' + (++sequence);
        if (targets.size >= 32) {
          const oldest = targets.keys().next().value;
          if (oldest) targets.delete(oldest);
        }
        ids.set(item.editor, id);
        targets.set(id, item);
      }
      selected = id;
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('click', remember, true);
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('input', remember, true);
    const inspect = (id) => {
      const item = targets.get(id);
      if (!item || !item.root.isConnected || !item.editor.isConnected || (item.subject && !item.subject.isConnected)) return null;
      const body = item.editor.innerText || '';
      const recipients = [];
      for (const node of item.root.querySelectorAll('[email], input[name="to"]')) {
        const value = node.getAttribute('email') || node.value || '';
        if (value && recipients.length < ${MAX_RECIPIENTS} && value.length <= ${MAX_RECIPIENT_LENGTH} && !recipients.includes(value)) recipients.push(value);
      }
      const unsupported = item.editor.querySelector('.gmail_signature, .gmail_quote, blockquote, img, table') !== null || Array.from(item.editor.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE && !(node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR'));
      return { subject: (item.subject?.value || '').slice(0, ${MAX_SUBJECT_LENGTH}), recipients, body, supported: !unsupported && body.length <= ${MAX_BODY_LENGTH} };
    };
    let active = true;
    globalThis[key] = {
      documentId,
      revoke() { active = false; document.removeEventListener('focusin', remember, true); document.removeEventListener('click', remember, true); document.removeEventListener('pointerdown', remember, true); document.removeEventListener('input', remember, true); globalThis[key] = null; },
      read() {
        if (!active) return null;
        if (selected === 'unsupported') return { targetId: 'unsupported', unsupported: true, snapshot: null };
        const snapshot = selected ? inspect(selected) : null;
        return { targetId: snapshot ? selected : null, snapshot };
      },
      readTarget(targetId) {
        if (!active) return null;
        const snapshot = inspect(targetId);
        return snapshot ? { targetId, snapshot } : null;
      },
      replace(targetId, expectedBody, replacement) {
        if (!active) return { status: 'stale_target' };
        const item = targets.get(targetId);
        const snapshot = inspect(targetId);
        if (!snapshot || !item) return { status: 'stale_target' };
        if (!snapshot.supported) return { status: 'unsupported' };
        if (snapshot.body !== expectedBody) return { status: 'conflict', body: snapshot.body };
        const lines = replacement.split('\\n');
        const nodes = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (index > 0) nodes.push(document.createElement('br'));
          if (lines[index]) nodes.push(document.createTextNode(lines[index]));
        }
        item.editor.replaceChildren(...nodes);
        item.editor.dispatchEvent(new Event('input', { bubbles: true }));
        const after = inspect(targetId);
        if (!after || !after.supported) return { status: 'unsupported' };
        if (after.body !== replacement) return { status: 'conflict', body: after.body };
        return { status: 'applied' };
      }
    };
    return true;
  })()`
}

function execute(contents: WebContents, code: string): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }], false)
}

function validPageResult(value: unknown): value is PageResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  if (result.targetId === null && result.snapshot === null) return true
  if (result.targetId === 'unsupported' && result.unsupported === true && result.snapshot === null)
    return true
  if (
    typeof result.targetId !== 'string' ||
    !result.snapshot ||
    typeof result.snapshot !== 'object'
  )
    return false
  const snapshot = result.snapshot as Record<string, unknown>
  return (
    typeof snapshot.subject === 'string' &&
    snapshot.subject.length <= MAX_SUBJECT_LENGTH &&
    Array.isArray(snapshot.recipients) &&
    snapshot.recipients.length <= MAX_RECIPIENTS &&
    snapshot.recipients.every(
      (recipient) => typeof recipient === 'string' && recipient.length <= MAX_RECIPIENT_LENGTH
    ) &&
    typeof snapshot.body === 'string' &&
    snapshot.body.length <= MAX_BODY_LENGTH &&
    typeof snapshot.supported === 'boolean'
  )
}

function validPageReplaceResult(value: unknown): value is PageReplaceResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return (
    ['applied', 'conflict', 'unsupported', 'stale_target'].includes(String(result.status)) &&
    (result.body === undefined ||
      (typeof result.body === 'string' && result.body.length <= MAX_BODY_LENGTH))
  )
}

export function createGmailComposeTargetService(options: {
  window: BrowserWindow
  views: Views
  access: Access
  getAccounts: () => readonly Account[]
}): {
  getStatus(): Promise<ComposeTargetStatus>
  getSnapshot(): Promise<ComposeSnapshotResult>
  applyDraft(request: AiMailComposeApplyRequest): Promise<AiMailComposeMutationResult>
  undoDraft(request: AiMailComposeUndoRequest): Promise<AiMailComposeMutationResult>
  isResultTargetCurrent(value: ComposeTargetStatus | ComposeSnapshotResult): Promise<boolean>
  isResultCurrent(value: ComposeTargetStatus | ComposeSnapshotResult): boolean
  onAccessState(state: AccountAccessState): void
  onAccountSwitch(): void
  dispose(): void
} {
  let context: Context | null = null
  let documentId: string | null = null
  let selectedId: string | null = null
  let selectedDomId: string | null = null
  let disposed = false
  let generation = 0
  let navListener:
    ((event: Electron.Event, url: string, inPlace: boolean, mainFrame: boolean) => void) | null =
    null
  let destroyedListener: (() => void) | null = null
  const resultLeases = new WeakMap<object, ComposeLease>()
  const snapshotLeases = new Map<string, { lease: ComposeLease; body: string }>()
  const applyRecords = new Map<
    string,
    { lease: ComposeLease; originalBody: string; appliedBody: string }
  >()
  const confirmedBodies = new Map<string, { leaseId: string; body: string }>()
  let mutationInFlight = false

  function clear(): void {
    generation += 1
    const old = context
    const oldDocumentId = documentId
    if (old && !old.contents.isDestroyed()) {
      if (navListener) old.contents.removeListener('did-start-navigation', navListener)
      if (destroyedListener) old.contents.removeListener('destroyed', destroyedListener)
      if (oldDocumentId)
        void execute(
          old.contents,
          `if (globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(oldDocumentId)}) globalThis.__hantongComposeTarget.revoke()`
        ).catch(() => undefined)
    }
    context = null
    documentId = null
    selectedId = null
    selectedDomId = null
    snapshotLeases.clear()
    applyRecords.clear()
    confirmedBodies.clear()
    navListener = null
    destroyedListener = null
  }

  function current(): Context | null {
    if (disposed || options.window.isDestroyed()) return null
    const accountId = options.views.getActiveAccountId()
    if (!accountId || !options.getAccounts().some((account) => account.id === accountId))
      return null
    if (options.access.getState(accountId).status !== 'ready') return null
    const view = options.views.getComposeProbeView(accountId)
    if (!view || view.contents.isDestroyed()) return null
    const lifecycleVersion = `${view.navigationRevision}:${view.accessRevision}`
    return {
      accountId,
      contents: view.contents,
      lifecycleVersion,
      documentVersion:
        context?.accountId === accountId &&
        context.contents === view.contents &&
        context.lifecycleVersion === lifecycleVersion
          ? context.documentVersion
          : ''
    }
  }

  async function capture(): Promise<{
    status: 'none' | 'stale' | 'access_locked' | 'unsupported' | 'ready'
    result?: PageResult
    ctx?: Context
  }> {
    const initial = current()
    if (!initial) {
      clear()
      const activeId = options.views.getActiveAccountId()
      return {
        status:
          activeId && options.access.getState(activeId).status !== 'ready'
            ? 'access_locked'
            : 'none'
      }
    }
    if (
      context?.contents !== initial.contents ||
      context.accountId !== initial.accountId ||
      context.lifecycleVersion !== initial.lifecycleVersion
    ) {
      clear()
      context = { ...initial, documentVersion: randomUUID() }
      const myGeneration = generation
      const localDocumentId = randomUUID()
      documentId = localDocumentId
      const onNavigation = (
        _event: Electron.Event,
        _url: string,
        inPlace: boolean,
        mainFrame: boolean
      ): void => {
        if (mainFrame && !inPlace) clear()
      }
      const onDestroyed = (): void => clear()
      navListener = onNavigation
      destroyedListener = onDestroyed
      initial.contents.on('did-start-navigation', onNavigation)
      initial.contents.on('destroyed', onDestroyed)
      try {
        const installed = await execute(
          initial.contents,
          gmailComposeTargetPageSource(localDocumentId)
        )
        const after = current()
        if (
          installed !== true ||
          generation !== myGeneration ||
          !after ||
          after.contents !== initial.contents ||
          after.accountId !== initial.accountId ||
          after.lifecycleVersion !== initial.lifecycleVersion
        ) {
          clear()
          return { status: 'stale' }
        }
      } catch {
        clear()
        return { status: 'unsupported' }
      }
    }
    const capturedContext = context
    const capturedDocument = documentId
    const capturedGeneration = generation
    if (!capturedContext || !capturedDocument) return { status: 'stale' }
    try {
      const value = await execute(
        capturedContext.contents,
        `globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(capturedDocument)} ? globalThis.__hantongComposeTarget.read() : null`
      )
      const after = current()
      if (
        generation !== capturedGeneration ||
        !after ||
        after.contents !== capturedContext.contents ||
        after.accountId !== capturedContext.accountId ||
        after.documentVersion !== capturedContext.documentVersion
      ) {
        clear()
        return { status: 'stale' }
      }
      if (!validPageResult(value)) return { status: 'unsupported' }
      if (!value.targetId || !value.snapshot) {
        if (value.unsupported) {
          selectedId = null
          selectedDomId = null
          return { status: 'unsupported' }
        }
        selectedId = null
        selectedDomId = null
        return { status: 'none' }
      }
      if (value.targetId !== selectedDomId) {
        selectedDomId = value.targetId
        selectedId = randomUUID()
      }
      return {
        status: value.snapshot.supported ? 'ready' : 'unsupported',
        result: value,
        ctx: capturedContext
      }
    } catch {
      clear()
      return { status: 'stale' }
    }
  }

  async function result(snapshot: boolean): Promise<ComposeTargetStatus | ComposeSnapshotResult> {
    const captured = await capture()
    if (captured.status !== 'ready') {
      if (captured.status === 'unsupported')
        return { status: 'unsupported', code: 'unsupported_content' }
      return { status: captured.status }
    }
    const capturedResult = captured.result
    const capturedContext = captured.ctx
    if (!capturedResult?.snapshot || !capturedContext) {
      clear()
      return { status: 'stale' }
    }
    const account = options.getAccounts().find((item) => item.id === capturedContext.accountId)
    if (!account) {
      clear()
      return { status: 'stale' }
    }
    const metadata = {
      accountId: account.id,
      composeId: selectedId ?? randomUUID(),
      accountLabel: (account.displayName || account.email || 'Gmail account').slice(0, 128),
      recipients: capturedResult.snapshot.recipients,
      subject: capturedResult.snapshot.subject
    }
    const lease = {
      generation,
      accountId: capturedContext.accountId,
      composeId: metadata.composeId,
      targetId: selectedDomId ?? '',
      contents: capturedContext.contents,
      lifecycleVersion: capturedContext.lifecycleVersion,
      documentVersion: capturedContext.documentVersion,
      probeDocumentId: documentId ?? ''
    }
    if (!snapshot) {
      const status = { status: 'ready' as const, ...metadata }
      resultLeases.set(status, lease)
      return status
    }
    const snapshotResult = {
      status: 'ready' as const,
      accountId: metadata.accountId,
      composeId: metadata.composeId,
      accountLabel: metadata.accountLabel,
      documentVersion: capturedContext.documentVersion,
      snapshotId: randomUUID(),
      recipients: metadata.recipients,
      subject: metadata.subject,
      body: capturedResult.snapshot.body
    }
    resultLeases.set(snapshotResult, lease)
    snapshotLeases.set(snapshotResult.snapshotId, {
      lease,
      body: capturedResult.snapshot.body
    })
    if (snapshotLeases.size > 32) {
      const oldest = snapshotLeases.keys().next().value
      if (oldest) snapshotLeases.delete(oldest)
    }
    return snapshotResult
  }

  function leaseIsCurrent(lease: ComposeLease): boolean {
    const latest = current()
    return Boolean(
      !disposed &&
      generation === lease.generation &&
      context?.contents === lease.contents &&
      documentId === lease.probeDocumentId &&
      context.documentVersion === lease.documentVersion &&
      context.lifecycleVersion === lease.lifecycleVersion &&
      latest?.accountId === lease.accountId &&
      latest.contents === lease.contents &&
      latest.lifecycleVersion === lease.lifecycleVersion
    )
  }

  async function replace(
    lease: ComposeLease,
    expectedBody: string,
    replacement: string
  ): Promise<PageReplaceResult | null> {
    if (!leaseIsCurrent(lease)) return null
    try {
      const value = await execute(
        lease.contents,
        `globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(lease.probeDocumentId)} ? globalThis.__hantongComposeTarget.replace(${JSON.stringify(lease.targetId)}, ${JSON.stringify(expectedBody)}, ${JSON.stringify(replacement)}) : null`
      )
      return leaseIsCurrent(lease) && validPageReplaceResult(value) ? value : null
    } catch {
      return null
    }
  }

  async function readTarget(lease: ComposeLease): Promise<PageResult | null> {
    if (!leaseIsCurrent(lease)) return null
    try {
      const value = await execute(
        lease.contents,
        `globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(lease.probeDocumentId)} ? globalThis.__hantongComposeTarget.readTarget(${JSON.stringify(lease.targetId)}) : null`
      )
      return leaseIsCurrent(lease) && validPageResult(value) ? value : null
    } catch {
      return null
    }
  }

  async function compareAndReplace(
    lease: ComposeLease,
    leaseId: string,
    expectedBody: string,
    replacement: string
  ): Promise<AiMailComposeMutationResult | PageReplaceResult> {
    const latest = await readTarget(lease)
    if (!latest || !leaseIsCurrent(lease)) return { status: 'stale_target' }
    if (!latest.snapshot?.supported) return { status: 'unsupported' }
    if (latest.snapshot.body !== expectedBody)
      return {
        status: 'conflict',
        currentVersion: rememberConflict(leaseId, latest.snapshot.body),
        currentBody: latest.snapshot.body
      }
    if (!leaseIsCurrent(lease)) return { status: 'stale_target' }
    const result = await replace(lease, expectedBody, replacement)
    return result ?? { status: 'stale_target' }
  }

  function rememberConflict(leaseId: string, body: string): string {
    const currentVersion = randomUUID()
    confirmedBodies.set(currentVersion, { leaseId, body })
    if (confirmedBodies.size > 32) {
      const oldest = confirmedBodies.keys().next().value
      if (oldest) confirmedBodies.delete(oldest)
    }
    return currentVersion
  }

  async function mutate(
    request: AiMailComposeApplyRequest | AiMailComposeUndoRequest,
    operation: 'apply' | 'undo'
  ): Promise<AiMailComposeMutationResult> {
    if (mutationInFlight) return { status: 'busy' }
    mutationInFlight = true
    try {
      if ((operation === 'apply') !== 'snapshotId' in request) return { status: 'stale_target' }
      if ('snapshotId' in request) {
        const snapshot = snapshotLeases.get(request.snapshotId)
        const lease = snapshot?.lease
        if (
          !snapshot ||
          !lease ||
          request.accountId !== lease.accountId ||
          request.composeId !== lease.composeId ||
          request.documentVersion !== lease.documentVersion ||
          !leaseIsCurrent(lease)
        )
          return { status: 'stale_target' }
        const confirmedVersion = request.confirmedCurrentVersion
        const confirmed = confirmedVersion ? confirmedBodies.get(confirmedVersion) : undefined
        if (confirmedVersion && (!confirmed || confirmed.leaseId !== request.snapshotId))
          return { status: 'stale_target' }
        const replacement = request.replacement.replace(/\r\n?/g, '\n')
        const result = await compareAndReplace(
          lease,
          request.snapshotId,
          confirmed?.body ?? snapshot.body,
          replacement
        )
        if (result.status === 'conflict') {
          if ('currentVersion' in result) return result
          if (typeof result.body === 'string')
            return {
              status: 'conflict',
              currentVersion: rememberConflict(request.snapshotId, result.body),
              currentBody: result.body
            }
          return { status: 'stale_target' }
        }
        if (result.status !== 'applied')
          return { status: result.status === 'unsupported' ? 'unsupported' : 'stale_target' }
        if (confirmedVersion) confirmedBodies.delete(confirmedVersion)
        const applyId = randomUUID()
        applyRecords.clear()
        applyRecords.set(applyId, {
          lease,
          originalBody: confirmed?.body ?? snapshot.body,
          appliedBody: replacement
        })
        snapshotLeases.delete(request.snapshotId)
        return { status: 'applied', applyId }
      }
      const record = applyRecords.get(request.applyId)
      const lease = record?.lease
      if (
        !record ||
        !lease ||
        request.accountId !== lease.accountId ||
        request.composeId !== lease.composeId ||
        request.documentVersion !== lease.documentVersion ||
        !leaseIsCurrent(lease)
      )
        return { status: 'stale_target' }
      const confirmedVersion = request.confirmedCurrentVersion
      const confirmed = confirmedVersion ? confirmedBodies.get(confirmedVersion) : undefined
      if (confirmedVersion && (!confirmed || confirmed.leaseId !== request.applyId))
        return { status: 'stale_target' }
      const result = await compareAndReplace(
        lease,
        request.applyId,
        confirmed?.body ?? record.appliedBody,
        record.originalBody
      )
      if (result.status === 'conflict') {
        if ('currentVersion' in result) return result
        if (typeof result.body === 'string')
          return {
            status: 'conflict',
            currentVersion: rememberConflict(request.applyId, result.body),
            currentBody: result.body
          }
        return { status: 'stale_target' }
      }
      if (result.status !== 'applied')
        return { status: result.status === 'unsupported' ? 'unsupported' : 'stale_target' }
      if (confirmedVersion) confirmedBodies.delete(confirmedVersion)
      applyRecords.delete(request.applyId)
      return { status: 'undone' }
    } finally {
      mutationInFlight = false
    }
  }

  function isResultCurrent(value: ComposeTargetStatus | ComposeSnapshotResult): boolean {
    if (!value || typeof value !== 'object' || value.status !== 'ready') return true
    const lease = resultLeases.get(value)
    const latest = current()
    return Boolean(
      lease &&
      !disposed &&
      generation === lease.generation &&
      context?.contents === lease.contents &&
      context.documentVersion === lease.documentVersion &&
      context.lifecycleVersion === lease.lifecycleVersion &&
      selectedId === lease.composeId &&
      selectedDomId === lease.targetId &&
      latest?.accountId === lease.accountId &&
      latest.contents === lease.contents &&
      latest.lifecycleVersion === lease.lifecycleVersion
    )
  }

  return {
    async getStatus() {
      return (await result(false)) as ComposeTargetStatus
    },
    async getSnapshot() {
      return (await result(true)) as ComposeSnapshotResult
    },
    applyDraft(request) {
      return mutate(request, 'apply')
    },
    undoDraft(request) {
      return mutate(request, 'undo')
    },
    async isResultTargetCurrent(value) {
      if (!value || typeof value !== 'object' || value.status !== 'ready') return true
      const lease = resultLeases.get(value)
      if (!lease || !isResultCurrent(value)) return false
      const latest = await capture()
      return Boolean(
        latest.status === 'ready' &&
        selectedId === lease.composeId &&
        selectedDomId === lease.targetId &&
        latest.ctx?.accountId === lease.accountId &&
        latest.ctx.contents === lease.contents &&
        latest.ctx.lifecycleVersion === lease.lifecycleVersion &&
        latest.ctx.documentVersion === lease.documentVersion
      )
    },
    isResultCurrent,
    onAccessState(state) {
      if (state.status !== 'ready' || state.accountId !== context?.accountId) clear()
    },
    onAccountSwitch() {
      clear()
    },
    dispose() {
      if (disposed) return
      disposed = true
      clear()
    }
  }
}
