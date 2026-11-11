import { randomUUID } from 'node:crypto'
import { createInterface, type Interface as ReadlineInterface } from 'node:readline'
import type { BrowserWindow, WebContents } from 'electron'
import type { AccountAccessState } from '../shared/ipc'
import type { createAccountAccessController } from './account-access-controller'
import type { createAccountViewManager } from './account-view-manager'

const PROBE_WORLD_ID = 7913
const MAX_BODY_LENGTH = 20_000
const SNAPSHOT_TTL_MS = 5 * 60_000
const SYNTHETIC_REPLACEMENT = 'Synthetic compose replacement for issue 33'
export const gmailComposeProbeLimits = Object.freeze({
  maxBodyLength: MAX_BODY_LENGTH,
  snapshotTtlMs: SNAPSHOT_TTL_MS
})
const SAFE_PROBE_STATUSES = new Set([
  'ready',
  'conflict',
  'stale_target',
  'signature_unsupported',
  'quote_unsupported',
  'format_unsupported',
  'body_too_large',
  'unsupported_format',
  'unsupported_content',
  'missing_snapshot',
  'missing_undo',
  'expired_snapshot',
  'verification_failed'
])

export function gmailComposeProbeStatusMessage(
  action: 'read',
  result: { readonly status: string }
): string {
  const safeStatus = SAFE_PROBE_STATUSES.has(result.status)
    ? result.status
    : 'operation_failed_safely'
  if (action === 'read' && safeStatus === 'ready')
    return 'Compose snapshot captured in Main memory.'
  return `${action} result: ${safeStatus}.`
}

type AccessController = ReturnType<typeof createAccountAccessController>
type ViewManager = ReturnType<typeof createAccountViewManager>

interface ProbeContext {
  readonly accountId: string
  readonly webContentsId: number
  readonly documentRevision: string
  readonly accessEpoch: number
  readonly activeAccountId: string
  readonly accountExists: true
  readonly accessGranted: true
}

interface ProbeTarget extends ProbeContext {
  readonly targetId: string
}

interface DraftSnapshot {
  readonly subject: string
  readonly body: string
  readonly supported: boolean
  readonly reason: string | null
}

interface ProbeDriver {
  hasTarget(target: ProbeTarget, context: ProbeContext): Promise<boolean>
  lastTarget(context: ProbeContext): Promise<string | null>
  read(target: ProbeTarget, context: ProbeContext): Promise<DraftSnapshot | null>
  readBody(target: ProbeTarget, context: ProbeContext): Promise<string | null>
  replaceBody(
    target: ProbeTarget,
    expectedBody: string,
    replacement: string,
    context: ProbeContext
  ): Promise<{ readonly status: string; readonly bodyAfter?: string }>
}

function sameContext(left: ProbeContext, right: ProbeContext): boolean {
  return (
    left.accountId === right.accountId &&
    left.webContentsId === right.webContentsId &&
    left.documentRevision === right.documentRevision &&
    left.accessEpoch === right.accessEpoch &&
    left.activeAccountId === left.accountId &&
    right.activeAccountId === right.accountId &&
    left.accountExists &&
    right.accountExists &&
    left.accessGranted &&
    right.accessGranted
  )
}

function isValidBody(value: string): boolean {
  return value.length <= MAX_BODY_LENGTH
}

function parseDraftSnapshot(value: unknown): DraftSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const result = value as Record<string, unknown>
  if (
    typeof result.subject !== 'string' ||
    typeof result.body !== 'string' ||
    typeof result.supported !== 'boolean' ||
    (result.reason !== null && typeof result.reason !== 'string')
  )
    return null
  return {
    subject: result.subject,
    body: result.body,
    supported: result.supported,
    reason: result.reason
  }
}

export function createGmailComposeProbeController(options: {
  getContext: () => ProbeContext | null
  driver: ProbeDriver
  now?: () => number
}): {
  observeLastUsedTarget(): Promise<boolean>
  read(): Promise<{ status: string }>
  replaceSample(): Promise<{ status: string }>
  undo(): Promise<{ status: string }>
  invalidate(): void
} {
  const now = options.now ?? Date.now
  let lastTarget: ProbeTarget | null = null
  let snapshot: {
    token: string
    target: ProbeTarget
    context: ProbeContext
    subject: string
    body: string
    observedAt: number
  } | null = null
  let undo: {
    token: string
    target: ProbeTarget
    context: ProbeContext
    originalBody: string
    expectedCurrentBody: string
  } | null = null

  function contextFor(target: ProbeTarget, expected: ProbeContext): ProbeContext | null {
    const current = options.getContext()
    if (
      !current ||
      target.accountId !== current.accountId ||
      target.webContentsId !== current.webContentsId ||
      target.documentRevision !== current.documentRevision ||
      target.accessEpoch !== current.accessEpoch ||
      !sameContext(expected, current)
    )
      return null
    return current
  }

  function invalidate(): void {
    lastTarget = null
    snapshot = null
    undo = null
  }

  async function checkedTarget(
    target: ProbeTarget | null
  ): Promise<{ status: string; context?: ProbeContext }> {
    const context = options.getContext()
    if (
      !target ||
      !context ||
      target.accountId !== context.accountId ||
      target.webContentsId !== context.webContentsId ||
      target.documentRevision !== context.documentRevision ||
      target.accessEpoch !== context.accessEpoch ||
      !sameContext(context, context) ||
      !(await options.driver.hasTarget(target, context))
    ) {
      invalidate()
      return { status: 'stale_target' }
    }
    const afterCheck = contextFor(target, context)
    if (!afterCheck) {
      invalidate()
      return { status: 'stale_target' }
    }
    return { status: 'ready', context }
  }

  return {
    async observeLastUsedTarget() {
      const context = options.getContext()
      if (!context || !sameContext(context, context)) {
        invalidate()
        return false
      }
      const targetId = await options.driver.lastTarget(context)
      if (!targetId || !contextFor({ ...context, targetId }, context)) {
        invalidate()
        return false
      }
      if (lastTarget && !sameContext(context, lastTarget)) invalidate()
      lastTarget = { ...context, targetId }
      return true
    },

    async read() {
      const target = lastTarget
      const checked = await checkedTarget(target)
      if (checked.status !== 'ready' || !checked.context || !target) return checked
      const draft = await options.driver.read(target, checked.context)
      if (!contextFor(target, checked.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (!draft || !isValidBody(draft.body)) return { status: 'unsupported_content' }
      if (!draft.supported) return { status: draft.reason ?? 'unsupported_format' }
      snapshot = {
        token: randomUUID(),
        target: { ...target },
        context: checked.context,
        subject: draft.subject,
        body: draft.body,
        observedAt: now()
      }
      return { status: 'ready' }
    },

    async replaceSample() {
      const current = snapshot
      if (!current) return { status: 'missing_snapshot' }
      if (now() - current.observedAt > SNAPSHOT_TTL_MS) {
        invalidate()
        return { status: 'expired_snapshot' }
      }
      const checked = await checkedTarget(current.target)
      if (checked.status !== 'ready' || !checked.context) return checked
      const bodyBeforeWrite = await options.driver.readBody(current.target, checked.context)
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (bodyBeforeWrite !== current.body) return { status: 'conflict' }
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      const write = await options.driver.replaceBody(
        current.target,
        current.body,
        SYNTHETIC_REPLACEMENT,
        current.context
      )
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (write.status === 'conflict' || write.status === 'stale_target')
        return { status: write.status }
      if (write.status === 'partial_write' && typeof write.bodyAfter === 'string') {
        undo = {
          token: randomUUID(),
          target: { ...current.target },
          context: current.context,
          originalBody: current.body,
          expectedCurrentBody: write.bodyAfter
        }
        snapshot = null
        return { status: 'partial_write_recovery_available' }
      }
      if (write.status === 'partial_write' && typeof write.bodyAfter === 'string') {
        undo = {
          token: randomUUID(),
          target: { ...current.target },
          context: current.context,
          originalBody: current.body,
          expectedCurrentBody: write.bodyAfter
        }
        return { status: 'partial_write_recovery_available' }
      }
      if (write.status !== 'applied') return { status: write.status || 'unsupported_format' }
      const bodyAfterWrite = await options.driver.readBody(current.target, current.context)
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (bodyAfterWrite !== SYNTHETIC_REPLACEMENT) return { status: 'verification_failed' }
      undo = {
        token: randomUUID(),
        target: { ...current.target },
        context: current.context,
        originalBody: current.body,
        expectedCurrentBody: SYNTHETIC_REPLACEMENT
      }
      snapshot = null
      return { status: 'applied' }
    },

    async undo() {
      const current = undo
      if (!current) return { status: 'missing_undo' }
      const checked = await checkedTarget(current.target)
      if (checked.status !== 'ready' || !checked.context) return checked
      const bodyBeforeUndo = await options.driver.readBody(current.target, checked.context)
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (bodyBeforeUndo !== current.expectedCurrentBody) return { status: 'conflict' }
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      const write = await options.driver.replaceBody(
        current.target,
        current.expectedCurrentBody,
        current.originalBody,
        current.context
      )
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (write.status === 'partial_write' && typeof write.bodyAfter === 'string') {
        current.expectedCurrentBody = write.bodyAfter
        return { status: 'partial_undo_recovery_available' }
      }
      if (write.status !== 'applied') return { status: write.status || 'unsupported_format' }
      const bodyAfterUndo = await options.driver.readBody(current.target, current.context)
      if (!contextFor(current.target, current.context)) {
        invalidate()
        return { status: 'stale_target' }
      }
      if (bodyAfterUndo !== current.originalBody) return { status: 'verification_failed' }
      undo = null
      return { status: 'undone' }
    },

    invalidate
  }
}

function composePageSource(documentId: string): string {
  return `(() => {
    const key = '__hantongGmailComposeProbe';
    const documentId = ${JSON.stringify(documentId)};
    if (globalThis[key]?.documentId === documentId) return true;
    globalThis[key]?.revoke?.();
    const editors = new Map();
    const editorIds = new WeakMap();
    let sequence = 0;
    let lastTargetId = null;
    const findCandidate = (target) => {
      if (!(target instanceof Element)) return null;
      const composeRoot = target.closest('[role="dialog"]');
      const subject = composeRoot?.querySelector('input[name="subjectbox"]');
      if (!composeRoot || !(subject instanceof HTMLInputElement)) return null;
      const bodySelector = 'div[contenteditable="true"][aria-label="Message Body"]';
      const editor = target.closest(bodySelector) ?? composeRoot.querySelector(bodySelector);
      return editor ? { editor, composeRoot, subject } : null;
    };
    const remember = (event) => {
      const candidate = findCandidate(event.target);
      if (!candidate) return;
      let id = editorIds.get(candidate.editor);
      if (!id) {
        id = 'compose-' + (++sequence);
        editorIds.set(candidate.editor, id);
        editors.set(id, candidate);
      }
      lastTargetId = id;
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('input', remember, true);
    const inspect = (id) => {
      const candidate = editors.get(id);
      if (!candidate?.editor.isConnected || !candidate.composeRoot.isConnected) return null;
      const editor = candidate.editor;
      let reason = null;
      if (editor.querySelector('.gmail_signature')) reason = 'signature_unsupported';
      else if (editor.querySelector('.gmail_quote, blockquote')) reason = 'quote_unsupported';
      else {
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_ELEMENT);
        let node = walker.nextNode();
        while (node && !reason) {
          if (node.tagName === 'BR') {
            if (node.attributes.length > 0) reason = 'format_unsupported';
          } else if (node.tagName === 'DIV') {
            if (
              Array.from(node.attributes).some(
                (attribute) =>
                  attribute.name !== 'dir' || !['ltr', 'rtl', 'auto'].includes(attribute.value)
              )
            )
              reason = 'format_unsupported';
          } else reason = 'format_unsupported';
          node = walker.nextNode();
        }
      }
      const body = editor.innerText ?? '';
      if (body.length > ${MAX_BODY_LENGTH}) reason = 'body_too_large';
      return {
        subject: candidate.subject.value,
        body,
        supported: reason === null,
        reason
      };
    };
    let active = true;
    globalThis[key] = {
      documentId,
      revoke() {
        active = false;
        document.removeEventListener('focusin', remember, true);
        document.removeEventListener('pointerdown', remember, true);
        document.removeEventListener('input', remember, true);
        globalThis[key] = null;
      },
      lastTarget() {
        return active && lastTargetId && inspect(lastTargetId)
          ? lastTargetId
          : null;
      },
      hasTarget(id) {
        return active && inspect(id) !== null;
      },
      read(id) {
        return active ? inspect(id) : null;
      },
    };
    return true;
  })()`
}

function executeInProbeWorld(
  contents: WebContents,
  code: string,
  userGesture = false
): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(PROBE_WORLD_ID, [{ code }], userGesture)
}

export function isGmailComposeProbeOptedIn(argv: readonly string[], isPackaged: boolean): boolean {
  return !isPackaged && argv.includes('--gmail-compose-probe')
}

export function createGmailComposeProbeRuntime(options: {
  readonly window: BrowserWindow
  readonly views: ViewManager
  readonly access: AccessController
  readonly accountExists: (accountId: string) => boolean
  readonly isPackaged: boolean
  readonly argv: readonly string[]
  readonly terminal?: ReadlineInterface
}): { dispose(): void; onAccessState(state: AccountAccessState): void } {
  if (!isGmailComposeProbeOptedIn(options.argv, options.isPackaged))
    throw new Error('Gmail compose probe requires an explicit unpackaged CLI opt-in')

  const terminal: ReadlineInterface =
    options.terminal ?? createInterface({ input: process.stdin, output: process.stdout })
  let authorized = false
  let accessEpoch = 0
  let controller: Pick<
    ReturnType<typeof createGmailComposeProbeController>,
    'observeLastUsedTarget' | 'read' | 'invalidate'
  > | null = null
  let boundContents: WebContents | null = null
  let boundAccountId: string | null = null
  let boundNavigationListener:
    | ((event: Electron.Event, url: string, isInPlace: boolean, isMainFrame: boolean) => void)
    | null = null
  let boundDestroyedListener: (() => void) | null = null
  let boundDocumentId: string | null = null
  let bindingGeneration = 0
  let disposed = false
  let terminalClosed = false

  function verifiedContext(): ProbeContext | null {
    if (disposed || options.window.isDestroyed()) return null
    const accountId = options.views.getActiveAccountId()
    if (!accountId || !options.accountExists(accountId)) return null
    if (options.access.getState(accountId).status !== 'ready') return null
    const view = options.views.getComposeProbeView(accountId)
    if (!view || view.contents.isDestroyed()) return null
    return {
      accountId,
      webContentsId: view.contents.id,
      documentRevision: `${view.navigationRevision}:${view.accessRevision}`,
      accessEpoch,
      activeAccountId: accountId,
      accountExists: true,
      accessGranted: true
    }
  }

  function currentContext(): ProbeContext | null {
    return authorized ? verifiedContext() : null
  }

  function resetBinding(): void {
    bindingGeneration += 1
    const documentId = boundDocumentId
    const contents = boundContents
    controller?.invalidate()
    controller = null
    authorized = false
    if (boundContents && !boundContents.isDestroyed()) {
      if (boundNavigationListener)
        boundContents.removeListener('did-start-navigation', boundNavigationListener)
      if (boundDestroyedListener) boundContents.removeListener('destroyed', boundDestroyedListener)
    }
    boundNavigationListener = null
    boundDestroyedListener = null
    boundContents = null
    boundAccountId = null
    boundDocumentId = null
    if (contents && documentId && !contents.isDestroyed()) {
      void executeInProbeWorld(
        contents,
        `if (globalThis.__hantongGmailComposeProbe?.documentId === ${JSON.stringify(documentId)}) globalThis.__hantongGmailComposeProbe.revoke()`
      ).catch(() => undefined)
    }
  }

  function contextMatchesBound(): boolean {
    const context = currentContext()
    return Boolean(
      context &&
      boundContents &&
      context.webContentsId === boundContents.id &&
      context.accountId === boundAccountId
    )
  }

  function sourceForCurrentDocument(contents: WebContents, documentId: string): Promise<unknown> {
    return executeInProbeWorld(contents, composePageSource(documentId))
  }

  function createDriver(contents: WebContents): ProbeDriver {
    function currentProbeDocumentId(): string | null {
      const context = currentContext()
      return context && sameContext(context, { ...context }) ? boundDocumentId : null
    }
    async function call(context: ProbeContext, code: string): Promise<unknown> {
      const current = currentContext()
      if (!current || !sameContext(current, context) || contents.id !== context.webContentsId)
        return null
      return executeInProbeWorld(contents, code)
    }
    return {
      async hasTarget(target, context) {
        return (
          (await call(
            context,
            `globalThis.__hantongGmailComposeProbe?.documentId === ${JSON.stringify(currentProbeDocumentId())} && globalThis.__hantongGmailComposeProbe?.hasTarget(${JSON.stringify(target.targetId)}) === true`
          )) === true
        )
      },
      async lastTarget(context) {
        const current = currentContext()
        if (!current || !sameContext(current, context) || contents.id !== context.webContentsId)
          return null
        const result = await call(
          context,
          `globalThis.__hantongGmailComposeProbe?.documentId === ${JSON.stringify(currentProbeDocumentId())} ? globalThis.__hantongGmailComposeProbe.lastTarget() : null`
        )
        return typeof result === 'string' ? result : null
      },
      async read(target, context) {
        const result = await call(
          context,
          `globalThis.__hantongGmailComposeProbe?.documentId === ${JSON.stringify(currentProbeDocumentId())} ? globalThis.__hantongGmailComposeProbe.read(${JSON.stringify(target.targetId)}) : null`
        )
        return parseDraftSnapshot(result)
      },
      async readBody() {
        return null
      },
      async replaceBody() {
        return { status: 'read_only' }
      }
    }
  }

  function bindingDocumentId(context: ProbeContext): string {
    return `${context.documentRevision}:${context.accessEpoch}:${randomUUID()}`
  }

  async function activateForCurrentAccount(): Promise<boolean> {
    const context = verifiedContext()
    if (!context) return false
    if (
      controller &&
      boundContents?.id === context.webContentsId &&
      boundAccountId === context.accountId &&
      boundDocumentId?.startsWith(`${context.documentRevision}:${context.accessEpoch}:`)
    )
      return true
    resetBinding()
    const generation = bindingGeneration
    const view = options.views.getComposeProbeView(context.accountId)
    if (!view || view.contents.id !== context.webContentsId) return false
    boundContents = view.contents
    boundAccountId = context.accountId
    const documentId = bindingDocumentId(context)
    boundDocumentId = documentId
    const onNavigation = (
      _event: Electron.Event,
      _url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame && !isInPlace) resetBinding()
    }
    const onDestroyed = (): void => resetBinding()
    boundNavigationListener = onNavigation
    boundDestroyedListener = onDestroyed
    view.contents.on('did-start-navigation', onNavigation)
    view.contents.on('destroyed', onDestroyed)
    try {
      const installed = await sourceForCurrentDocument(view.contents, documentId)
      const current = verifiedContext()
      if (
        installed !== true ||
        generation !== bindingGeneration ||
        !current ||
        !sameContext(current, context) ||
        boundContents !== view.contents ||
        view.contents.isDestroyed()
      ) {
        resetBinding()
        return false
      }
      authorized = true
      const readController = createGmailComposeProbeController({
        getContext: currentContext,
        driver: createDriver(view.contents)
      })
      controller = {
        observeLastUsedTarget: () => readController.observeLastUsedTarget(),
        read: () => readController.read(),
        invalidate: () => readController.invalidate()
      }
      return true
    } catch {
      resetBinding()
      return false
    }
  }

  async function run(command: string): Promise<void> {
    if (disposed || options.window.isDestroyed()) return
    if (command === 'status') {
      console.info(
        currentContext()
          ? 'Gmail compose probe access is ready.'
          : 'Gmail compose probe access is locked.'
      )
      return
    }
    if (command === 'authorize-synthetic-test-account') {
      if (!(await activateForCurrentAccount())) {
        console.info(
          'Probe remains locked until the active account passes Main Gmail access verification.'
        )
        return
      }
      console.info(
        'Probe enabled for the currently active Main-verified account; proceed only with the manager-authorized synthetic test account.'
      )
      return
    }
    if (!controller || !contextMatchesBound()) {
      resetBinding()
      console.info(
        'Probe access is locked; select and verify an account, then authorize the synthetic test account.'
      )
      return
    }
    if (command === 'read') {
      if (!(await controller.observeLastUsedTarget())) {
        console.info('No supported last-used compose target is available.')
        return
      }
      const result = await controller.read()
      console.info(gmailComposeProbeStatusMessage('read', result))
      return
    }
    if (command === 'revoke') {
      resetBinding()
      console.info('Probe snapshots and undo were cleared.')
      return
    }
    console.info('Commands: status, authorize-synthetic-test-account, read, revoke, quit.')
  }

  function prompt(): void {
    if (disposed || terminalClosed) return
    terminal.question('gmail-compose-probe> ', (line) => {
      const command = line.trim()
      if (command === 'quit') {
        dispose()
        return
      }
      void run(command)
        .catch(() => {
          console.info('Probe command failed safely; no content was logged.')
        })
        .finally(prompt)
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    resetBinding()
    terminal.close()
  }

  terminal.on('close', () => {
    terminalClosed = true
    if (!disposed) dispose()
  })

  prompt()
  return {
    dispose,
    onAccessState(state) {
      if (state.status !== 'ready' || state.accountId !== boundAccountId) {
        accessEpoch += 1
        resetBinding()
      }
    }
  }
}
