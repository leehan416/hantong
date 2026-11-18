import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type { AccountAccessState, ReadMailSnapshotResult } from '../shared/ipc'
import type { createAccountAccessController } from './account-access-controller'
import type { createAccountViewManager } from './account-view-manager'

const WORLD_ID = 7913
const MAX_TEXT_LENGTH = 20_000
type Views = ReturnType<typeof createAccountViewManager>
type Access = ReturnType<typeof createAccountAccessController>
type Account = { id: string; email?: string | null; displayName?: string | null }
type View = { contents: WebContents; navigationRevision: number; accessRevision: number }
type Context = { accountId: string; contents: WebContents; revision: string }
type PageRead =
  | { status: 'ready'; snapshot: { targetId: string; subject: string; body: string } }
  | { status: 'none' | 'unsupported' }

export function gmailReadTargetPageSource(documentId: string): string {
  return `(() => {
    const key = '__hantongReadMailTarget';
    const documentId = ${JSON.stringify(documentId)};
    if (globalThis[key]?.documentId === documentId) return true;
    globalThis[key]?.revoke?.();
    let active = true;
    let priorIdentity = '';
    let targetSequence = 0;
    const visible = (node) => {
      if (!(node instanceof Element) || !node.isConnected || node.getClientRects().length === 0) return false;
      const style = node.ownerDocument.defaultView.getComputedStyle(node);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
    };
    const read = () => {
      if (!active) return { status: 'unsupported' };
      const main = document.querySelector('[role="main"]');
      if (!main) return { status: 'unsupported' };
      const bodies = Array.from(main.querySelectorAll('[data-message-id] .a3s')).filter(visible);
      const subjects = Array.from(main.querySelectorAll('h2')).filter(visible);
      if (!bodies.length) return { status: 'none' };
      if (bodies.length !== 1 || subjects.length !== 1) return { status: 'unsupported' };
      const bodyNode = bodies[0];
      const message = bodyNode.closest('[data-message-id]');
      const messageId = message?.getAttribute('data-message-id') || '';
      const subject = (subjects[0].innerText || '').trim();
      const body = (bodyNode.innerText || '').trim();
      if (!messageId || !subject || subject.length > 998 || !body || body.length > ${MAX_TEXT_LENGTH}) return { status: 'unsupported' };
      const identity = messageId + '\\u0000' + subject;
      if (identity !== priorIdentity) { priorIdentity = identity; targetSequence += 1; }
      return { status: 'ready', snapshot: { targetId: 'read-' + targetSequence, subject, body } };
    };
    globalThis[key] = { documentId, revoke() { active = false; globalThis[key] = null; }, read };
    return true;
  })()`
}

function execute(contents: WebContents, code: string): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code }], false)
}

export function createGmailReadTargetService(options: {
  window: BrowserWindow
  views: Views
  access: Access
  getAccounts: () => readonly Account[]
}): {
  getSnapshot(): Promise<ReadMailSnapshotResult>
  isSnapshotCurrent(captureId: string): Promise<boolean>
  onAccessState(state: AccountAccessState): void
  onAccountSwitch(): void
  dispose(): void
} {
  let context: Context | null = null
  let documentId: string | null = null
  let generation = 0
  let disposed = false
  let navListener:
    ((details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => void) | null =
    null
  let destroyListener: (() => void) | null = null
  const leases = new Map<
    string,
    {
      generation: number
      context: Context
      documentId: string
      targetId: string
      subject: string
      body: string
    }
  >()

  function current(): Context | null {
    if (disposed || options.window.isDestroyed()) return null
    const accountId = options.views.getActiveAccountId()
    if (
      !accountId ||
      !options.getAccounts().some((item) => item.id === accountId) ||
      options.access.getState(accountId).status !== 'ready'
    )
      return null
    const view: View | null = options.views.getReadMailView(accountId)
    if (!view || view.contents.isDestroyed()) return null
    return {
      accountId,
      contents: view.contents,
      revision: `${view.navigationRevision}:${view.accessRevision}`
    }
  }

  function clear(expectedContext?: Context, expectedGeneration?: number): void {
    if (
      (expectedContext && context !== expectedContext) ||
      (expectedGeneration !== undefined && generation !== expectedGeneration)
    )
      return
    generation += 1
    const old = context
    if (old && !old.contents.isDestroyed()) {
      if (navListener) old.contents.removeListener('did-start-navigation', navListener)
      if (destroyListener) old.contents.removeListener('destroyed', destroyListener)
      if (documentId)
        void execute(
          old.contents,
          `if (globalThis.__hantongReadMailTarget?.documentId === ${JSON.stringify(documentId)}) globalThis.__hantongReadMailTarget.revoke()`
        ).catch(() => undefined)
    }
    context = null
    documentId = null
    leases.clear()
    navListener = null
    destroyListener = null
  }

  async function capture(): Promise<ReadMailSnapshotResult> {
    const initial = current()
    if (!initial) {
      clear()
      return { status: options.views.getActiveAccountId() ? 'access_locked' : 'none' }
    }
    if (
      context?.contents !== initial.contents ||
      context.accountId !== initial.accountId ||
      context.revision !== initial.revision
    ) {
      clear()
      context = initial
      documentId = randomUUID()
      const localGeneration = generation
      navListener = (details) => {
        if (details.isMainFrame) clear(initial, localGeneration)
      }
      destroyListener = () => clear(initial, localGeneration)
      initial.contents.on('did-start-navigation', navListener)
      initial.contents.on('destroyed', destroyListener)
      try {
        const installed = await execute(initial.contents, gmailReadTargetPageSource(documentId))
        const latest = current()
        if (
          installed !== true ||
          generation !== localGeneration ||
          !latest ||
          latest.accountId !== initial.accountId ||
          latest.contents !== initial.contents ||
          latest.revision !== initial.revision
        ) {
          clear(initial, localGeneration)
          return { status: 'stale' }
        }
      } catch {
        clear(initial, localGeneration)
        return { status: 'unsupported', code: 'unsupported_read_mail' }
      }
    }
    const localContext = context
    const localDocument = documentId
    const localGeneration = generation
    if (!localContext || !localDocument) return { status: 'stale' }
    try {
      const value = (await execute(
        localContext.contents,
        `globalThis.__hantongReadMailTarget?.documentId === ${JSON.stringify(localDocument)} ? globalThis.__hantongReadMailTarget.read() : null`
      )) as PageRead | null
      const latest = current()
      if (
        generation !== localGeneration ||
        !latest ||
        latest.accountId !== localContext.accountId ||
        latest.contents !== localContext.contents ||
        latest.revision !== localContext.revision
      ) {
        clear(localContext, localGeneration)
        return { status: 'stale' }
      }
      if (!value || !['ready', 'none', 'unsupported'].includes(value.status))
        return { status: 'unsupported', code: 'unsupported_read_mail' }
      if (value.status !== 'ready')
        return value.status === 'none'
          ? { status: 'none' }
          : { status: 'unsupported', code: 'unsupported_read_mail' }
      const snapshot = value.snapshot
      if (
        !snapshot ||
        typeof snapshot.targetId !== 'string' ||
        !/^read-[0-9]{1,10}$/.test(snapshot.targetId) ||
        typeof snapshot.subject !== 'string' ||
        snapshot.subject.length > 998 ||
        typeof snapshot.body !== 'string' ||
        !snapshot.body.length ||
        snapshot.body.length > MAX_TEXT_LENGTH
      )
        return { status: 'unsupported', code: 'unsupported_read_mail' }
      const account = options.getAccounts().find((item) => item.id === localContext.accountId)
      if (!account) return { status: 'stale' }
      const captureId = randomUUID()
      leases.set(captureId, {
        generation,
        context: localContext,
        documentId: localDocument,
        ...snapshot
      })
      while (leases.size > 24) {
        const oldest = leases.keys().next().value
        if (oldest === undefined) break
        leases.delete(oldest)
      }
      return {
        status: 'ready',
        accountId: account.id,
        accountLabel: (account.displayName || account.email || 'Gmail account').slice(0, 128),
        captureId,
        subject: snapshot.subject,
        body: snapshot.body
      }
    } catch {
      clear(localContext, localGeneration)
      return { status: 'stale' }
    }
  }

  async function isSnapshotCurrent(captureId: string): Promise<boolean> {
    const lease = leases.get(captureId)
    if (
      !lease ||
      disposed ||
      lease.generation !== generation ||
      context !== lease.context ||
      documentId !== lease.documentId
    )
      return false
    const latest = current()
    if (
      !latest ||
      latest.accountId !== lease.context.accountId ||
      latest.contents !== lease.context.contents ||
      latest.revision !== lease.context.revision
    )
      return false
    try {
      const value = (await execute(
        lease.context.contents,
        `globalThis.__hantongReadMailTarget?.documentId === ${JSON.stringify(lease.documentId)} ? globalThis.__hantongReadMailTarget.read() : null`
      )) as PageRead | null
      const after = current()
      return Boolean(
        value?.status === 'ready' &&
        value.snapshot.targetId === lease.targetId &&
        value.snapshot.subject === lease.subject &&
        value.snapshot.body === lease.body &&
        after?.contents === lease.context.contents &&
        after.accountId === lease.context.accountId &&
        after.revision === lease.context.revision &&
        generation === lease.generation
      )
    } catch {
      return false
    }
  }

  return {
    getSnapshot: capture,
    isSnapshotCurrent,
    onAccessState(state) {
      if (state.status !== 'ready' || state.accountId !== context?.accountId) clear()
    },
    onAccountSwitch() {
      clear()
    },
    dispose() {
      if (!disposed) {
        disposed = true
        clear()
      }
    }
  }
}
