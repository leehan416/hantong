import { randomUUID } from 'node:crypto'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  AccountAccessState,
  AiMailComposeApplyRequest,
  AiMailComposeMutationResult,
  AiMailComposeUndoRequest,
  ComposeCandidate,
  ComposeCandidateSelectionRequest,
  ComposeDiscoverySummary,
  ComposeSnapshotResult,
  ComposeTargetStatus
} from '~/shared/ipc'
import type { createAccountAccessController } from '~/main/accounts/account-access-controller'
import type { createAccountViewManager } from '~/main/accounts/account-view-manager'

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
  targets?: Array<{
    targetId: string
    title: string
    subject: string
    recipients: string[]
    supported: boolean
    lastUsedAt: number
  }>
  unsupported?: boolean
  discovery?: ComposeDiscoverySummary
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
    const lastUsedAt = new Map();
    let sequence = 0;
    let selected = null;
    let lastFocusedEditor = null;
    let discoveryBaselineComplete = false;
    const candidateFor = (node) => {
      if (!(node instanceof Element)) return null;
      const editor = node.matches('[contenteditable="true"]') ? node : node.closest('[contenteditable="true"]');
      let root = editor || node;
      // Gmail's compose puts the subject box more than 12 levels above the body editor.
      // The one-editor / at-most-one-subject checks below keep a deeper walk from
      // spanning a second compose or another editable.
      for (let depth = 0; root && depth < 32; depth += 1, root = root.parentElement) {
        const editors = Array.from(root.querySelectorAll('[contenteditable="true"]'));
        const subjects = Array.from(root.querySelectorAll('input[name="subjectbox"]'));
        if (editors.length !== 1 || (editor && editors[0] !== editor) || subjects.length > 1) continue;
        // Inline replies keep a hidden subjectbox; treat it like a reply (no editable subject)
        // instead of rejecting the whole compose as not visible.
        if (subjects.length === 1 && subjects[0] instanceof HTMLInputElement) return { root, editor: editors[0], subject: eligible(subjects[0]) ? subjects[0] : null };
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
    const rememberTarget = (item, allowEvicted = false) => {
      let id = ids.get(item.editor);
      if (id && targets.has(id)) {
        targets.set(id, item);
        return id;
      }
      if (id && !allowEvicted) return null;
      id = 'target-' + (++sequence);
      if (targets.size >= 32) {
        const oldest = targets.keys().next().value;
        if (oldest) {
          targets.delete(oldest);
          lastUsedAt.delete(oldest);
        }
      }
      ids.set(item.editor, id);
      targets.set(id, item);
      return id;
    };
    const remember = (event) => {
      const item = candidateFor(event.target);
      const eventNode = event.target;
      if (eventNode instanceof Element) {
        const focusedEditor = eventNode.matches('[contenteditable="true"]') ? eventNode : eventNode.closest('[contenteditable="true"]');
        if (focusedEditor) lastFocusedEditor = focusedEditor;
      }
      if (!item) {
        const node = event.target;
        if (node instanceof Element && (node.matches('[contenteditable="true"]') || node.closest('[contenteditable="true"]'))) selected = 'unsupported';
        return;
      }
      const id = rememberTarget(item, true);
      selected = id;
      lastUsedAt.set(id, Date.now());
    };
    document.addEventListener('focusin', remember, true);
    document.addEventListener('click', remember, true);
    document.addEventListener('pointerdown', remember, true);
    document.addEventListener('input', remember, true);
    const inspect = (id) => {
      const item = targets.get(id);
      if (!item || !eligible(item.root) || !eligible(item.editor) || (item.subject && !eligible(item.subject))) return null;
      const bodyText = item.editor.innerText || '';
      const placeholder = item.editor.getAttribute('aria-placeholder') || item.editor.getAttribute('data-placeholder');
      const tooLarge = bodyText.length > ${MAX_BODY_LENGTH};
      const body = tooLarge || bodyText === placeholder || /^[\\s\\u200B\\uFEFF]*$/.test(bodyText) ? '' : bodyText;
      const recipients = [];
      for (const node of item.root.querySelectorAll('[email], input[name="to"]')) {
        const value = node.getAttribute('email') || node.value || '';
        if (value && recipients.length < ${MAX_RECIPIENTS} && value.length <= ${MAX_RECIPIENT_LENGTH} && !recipients.includes(value)) recipients.push(value);
      }
      const unsupported = item.editor.querySelector('.gmail_signature, .gmail_quote, blockquote, img, table') !== null || Array.from(item.editor.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE && !(node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR'));
      return { subject: (item.subject?.value || '').slice(0, ${MAX_SUBJECT_LENGTH}), recipients, body, supported: !unsupported && !tooLarge };
    };
    const eligible = (node) => {
      if (!node || !node.isConnected) return false;
      if (node.closest?.('[aria-hidden="true"]')) return false;
      if (typeof node.getClientRects === 'function' && !node.getClientRects().length) return false;
      if (typeof getComputedStyle === 'function') {
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    };
    const structureSummary = () => {
      const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      const subjects = Array.from(document.querySelectorAll('input[name="subjectbox"]'));
      const active = document.activeElement;
      const activeEditor = active instanceof Element ? (active.matches('[contenteditable="true"]') ? active : active.closest('[contenteditable="true"]')) : null;
      const editor = activeEditor && activeEditor.isConnected ? activeEditor : (lastFocusedEditor?.isConnected ? lastFocusedEditor : null);
      const root = editor || document.body || document.documentElement;
      const replySelectors = 'button[aria-label*="Reply"], [role="button"][aria-label*="Reply"], button[data-tooltip*="Reply"], [role="button"][data-tooltip*="Reply"], button[aria-label*="답장"], [role="button"][aria-label*="답장"], button[data-tooltip*="답장"], [role="button"][data-tooltip*="답장"]';
      const branchMatch = (ancestor) => {
        if (!editor || !ancestor) return { match: false, shared: false };
        const markers = Array.from(ancestor.querySelectorAll(replySelectors));
        for (const marker of markers) {
          let editorBranch = editor;
          while (editorBranch && editorBranch.parentElement !== ancestor) editorBranch = editorBranch.parentElement;
          let markerBranch = marker;
          while (markerBranch && markerBranch.parentElement !== ancestor) markerBranch = markerBranch.parentElement;
          if (editorBranch && editorBranch === markerBranch) return { match: true, shared: true };
        }
        return { match: markers.length > 0, shared: false };
      };
      const validity = subjects.slice(0, 12).filter((item) => item instanceof HTMLInputElement).map((item) => {
        const state = item.validity;
        return { valid: state.valid, willValidate: item.willValidate, valueMissing: state.valueMissing, typeMismatch: state.typeMismatch, patternMismatch: state.patternMismatch, tooLong: state.tooLong, tooShort: state.tooShort, rangeUnderflow: state.rangeUnderflow, rangeOverflow: state.rangeOverflow, stepMismatch: state.stepMismatch, badInput: state.badInput, customError: state.customError };
      });
      const ancestors = [];
      for (let node = root, depth = 0; node && depth < 12; node = node.parentElement, depth += 1) {
        const branch = branchMatch(node);
        const tag = node === document ? 'document' : node.tagName === 'FORM' ? 'form' : node.tagName === 'INPUT' ? 'input' : ['BODY', 'HTML', 'DIV', 'TABLE', 'SECTION', 'MAIN'].includes(node.tagName) ? 'container' : 'other';
        ancestors.push({ depth, tag, childCount: Math.min(node.children?.length || 0, 1000), editableCount: Math.min(node.querySelectorAll?.('[contenteditable="true"]').length || 0, 1000), subjectBoxCount: Math.min(node.querySelectorAll?.('input[name="subjectbox"]').length || 0, 1000), replyMarkerCount: Math.min(node.querySelectorAll?.(replySelectors).length || 0, 1000), visible: eligible(node), replyMarkerMatch: branch.match, sharedBranch: branch.shared });
      }
      const match = branchMatch(root);
      return { editableCount: Math.min(editors.length, 1000), subjectBoxCount: Math.min(subjects.length, 1000), focusedEditable: Boolean(editor && eligible(editor)), replyMarkerMatch: match.match, sharedBranch: match.shared, subjectValidity: validity, ancestors };
    };
    const describe = (id) => {
      const item = targets.get(id);
      if (!item || !eligible(item.root) || !eligible(item.editor) || (item.subject && !eligible(item.subject))) return null;
      const recipients = [];
      for (const node of item.root.querySelectorAll('[email], input[name="to"]')) {
        const value = node.getAttribute('email') || node.value || '';
        if (value && recipients.length < ${MAX_RECIPIENTS} && value.length <= ${MAX_RECIPIENT_LENGTH} && !recipients.includes(value)) recipients.push(value);
      }
      const unsupported = item.editor.querySelector('.gmail_signature, .gmail_quote, blockquote, img, table') !== null || Array.from(item.editor.childNodes).some((node) => node.nodeType !== Node.TEXT_NODE && !(node.nodeType === Node.ELEMENT_NODE && node.nodeName === 'BR'));
      const subject = (item.subject?.value || '').slice(0, ${MAX_SUBJECT_LENGTH});
      const title = item.root.querySelector('[aria-label]')?.getAttribute('aria-label') || subject || recipients[0] || 'New message';
      return { targetId: id, title: String(title).slice(0, 160), subject, recipients, supported: !unsupported, lastUsedAt: lastUsedAt.get(id) || 0 };
    };
    let discovery = { editorCount: 0, candidateCount: 0, rejectedNoMatch: 0, rejectedNotVisible: 0, capacityEvictions: 0 };
    const discoverOpenComposes = () => {
      if (typeof document.querySelectorAll !== 'function') return;
      const candidates = new Map();
      const editors = Array.from(document.querySelectorAll('[contenteditable="true"]'));
      let rejectedNoMatch = 0;
      let rejectedNotVisible = 0;
      let capacityEvictions = 0;
      for (const editor of editors) {
        if (!(editor instanceof Element)) {
          rejectedNoMatch += 1;
          continue;
        }
        const item = candidateFor(editor);
        if (!item) {
          rejectedNoMatch += 1;
          continue;
        }
        if (!eligible(item.root) || !eligible(editor) || (item.subject && !eligible(item.subject))) {
          rejectedNotVisible += 1;
          continue;
        }
        candidates.set(item.editor, item);
      }
      const newlyDiscoveredIds = [];
      for (const item of candidates.values()) {
        const hadIdentity = ids.has(item.editor);
        const existingId = ids.get(item.editor);
        if (
          (existingId && !targets.has(existingId)) ||
          (!hadIdentity && targets.size >= 32)
        )
          capacityEvictions += 1;
        const id = rememberTarget(item);
        if (id && discoveryBaselineComplete && !hadIdentity) newlyDiscoveredIds.push(id);
      }
      discovery = {
        editorCount: Math.min(editors.length, 1000),
        candidateCount: Math.min(candidates.size, 1000),
        rejectedNoMatch: Math.min(rejectedNoMatch, 1000),
        rejectedNotVisible: Math.min(rejectedNotVisible, 1000),
        capacityEvictions: Math.min(capacityEvictions, 1000),
        structure: structureSummary()
      };
      if (!discoveryBaselineComplete) {
        discoveryBaselineComplete = true;
      } else if (newlyDiscoveredIds.length) {
        const openedAt = Date.now();
        for (const id of newlyDiscoveredIds) lastUsedAt.set(id, openedAt);
      }
      if (selected && !candidates.has(targets.get(selected)?.editor)) selected = null;
      if (!selected && candidates.size === 1) {
        const item = candidates.values().next().value;
        const id = ids.get(item.editor);
        if (id) selected = id;
      }
      return candidates.size;
    };
    let active = true;
    let discoveryTimer = null;
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
      if (discoveryTimer !== null) return;
      discoveryTimer = setTimeout(() => {
        discoveryTimer = null;
        if (active) discoverOpenComposes();
      }, 100);
    }) : null;
    if (document.documentElement) observer?.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['contenteditable', 'name']
    });
    globalThis[key] = {
      documentId,
      revoke() { active = false; observer?.disconnect(); if (discoveryTimer !== null) clearTimeout(discoveryTimer); document.removeEventListener('focusin', remember, true); document.removeEventListener('click', remember, true); document.removeEventListener('pointerdown', remember, true); document.removeEventListener('input', remember, true); globalThis[key] = null; },
      read() {
        if (!active) return null;
        if (selected === 'unsupported') selected = null;
        if (!selected) discoverOpenComposes();
        let snapshot = selected ? inspect(selected) : null;
        if (selected && !snapshot) {
          selected = null;
        }
        if (!selected) {
          discoverOpenComposes();
          snapshot = selected ? inspect(selected) : null;
        }
        discoverOpenComposes();
        return { targetId: snapshot ? selected : null, snapshot, targets: Array.from(targets.keys()).map(describe).filter(Boolean).sort((a, b) => b.lastUsedAt - a.lastUsedAt), discovery };
      },
      listTargets() {
        if (!active) return [];
        discoverOpenComposes();
        return Array.from(targets.keys()).map(describe).filter(Boolean).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      },
      selectTarget(targetId) {
        if (!active || !targets.has(targetId) || !inspect(targetId)) return false;
        selected = targetId;
        return true;
      },
      readTarget(targetId) {
        if (!active) return null;
        const snapshot = inspect(targetId);
        return snapshot ? { targetId, snapshot } : null;
      },
      replace(targetId, expectedBody, replacement) {
        if (!active || selected !== targetId) return { status: 'stale_target' };
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
      },
      replaceSubject(targetId, expectedSubject, replacement) {
        if (!active || selected !== targetId) return { status: 'stale_target' };
        const item = targets.get(targetId);
        const snapshot = inspect(targetId);
        if (!snapshot || !item || !item.subject) return { status: 'stale_target' };
        if (!snapshot.supported) return { status: 'unsupported' };
        if (snapshot.subject !== expectedSubject) return { status: 'conflict', body: snapshot.subject };
        item.subject.value = replacement;
        item.subject.dispatchEvent(new Event('input', { bubbles: true }));
        const after = inspect(targetId);
        if (!after || after.subject !== replacement) return { status: 'conflict', body: after?.subject || '' };
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
  if (result.discovery !== undefined) {
    if (!result.discovery || typeof result.discovery !== 'object') return false
    const discovery = result.discovery as Record<string, unknown>
    const fields = [
      'editorCount',
      'candidateCount',
      'rejectedNoMatch',
      'rejectedNotVisible',
      'capacityEvictions'
    ]
    if (
      fields.some((field) => !(field in discovery)) ||
      Object.keys(discovery).some((field) => ![...fields, 'structure'].includes(field)) ||
      fields.some(
        (field) =>
          !Number.isSafeInteger(discovery[field]) ||
          Number(discovery[field]) < 0 ||
          Number(discovery[field]) > 1000
      )
    )
      return false
    if (discovery.structure !== undefined && !validStructureSummary(discovery.structure))
      return false
  }
  const validCandidates =
    result.targets === undefined ||
    (Array.isArray(result.targets) &&
      result.targets.length <= 32 &&
      result.targets.every((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false
        const item = candidate as Record<string, unknown>
        return (
          typeof item.targetId === 'string' &&
          item.targetId.length <= 64 &&
          typeof item.title === 'string' &&
          item.title.length <= 160 &&
          typeof item.subject === 'string' &&
          item.subject.length <= MAX_SUBJECT_LENGTH &&
          Array.isArray(item.recipients) &&
          item.recipients.length <= MAX_RECIPIENTS &&
          item.recipients.every(
            (entry) => typeof entry === 'string' && entry.length <= MAX_RECIPIENT_LENGTH
          ) &&
          typeof item.supported === 'boolean' &&
          typeof item.lastUsedAt === 'number' &&
          Number.isFinite(item.lastUsedAt)
        )
      }))
  if (!validCandidates) return false
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

function validStructureSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const bools = ['focusedEditable', 'replyMarkerMatch', 'sharedBranch']
  const counts = ['editableCount', 'subjectBoxCount']
  const validityFields = [
    'valid',
    'willValidate',
    'valueMissing',
    'typeMismatch',
    'patternMismatch',
    'tooLong',
    'tooShort',
    'rangeUnderflow',
    'rangeOverflow',
    'stepMismatch',
    'badInput',
    'customError'
  ]
  const ancestorFields = [
    'depth',
    'tag',
    'childCount',
    'editableCount',
    'subjectBoxCount',
    'replyMarkerCount',
    'visible',
    'replyMarkerMatch',
    'sharedBranch'
  ]
  return (
    Object.keys(item).length === 7 &&
    bools.every((key) => typeof item[key] === 'boolean') &&
    counts.every(
      (key) =>
        Number.isSafeInteger(item[key]) && Number(item[key]) >= 0 && Number(item[key]) <= 1000
    ) &&
    Array.isArray(item.subjectValidity) &&
    item.subjectValidity.length <= 12 &&
    item.subjectValidity.every((entry) =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === validityFields.length &&
        validityFields.every((key) => typeof (entry as Record<string, unknown>)[key] === 'boolean')
      )
    ) &&
    Array.isArray(item.ancestors) &&
    item.ancestors.length <= 12 &&
    item.ancestors.every((entry, index) =>
      Boolean(
        entry &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Object.keys(entry).length === ancestorFields.length &&
        Number((entry as Record<string, unknown>).depth) === index &&
        ['document', 'container', 'form', 'input', 'other'].includes(
          String((entry as Record<string, unknown>).tag)
        ) &&
        ['childCount', 'editableCount', 'subjectBoxCount', 'replyMarkerCount'].every(
          (key) =>
            Number.isSafeInteger((entry as Record<string, unknown>)[key]) &&
            Number((entry as Record<string, unknown>)[key]) >= 0 &&
            Number((entry as Record<string, unknown>)[key]) <= 1000
        ) &&
        ['visible', 'replyMarkerMatch', 'sharedBranch'].every(
          (key) => typeof (entry as Record<string, unknown>)[key] === 'boolean'
        )
      )
    )
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
  selectTarget(request: ComposeCandidateSelectionRequest): Promise<ComposeSnapshotResult>
  applyDraft(request: AiMailComposeApplyRequest): Promise<AiMailComposeMutationResult>
  undoDraft(request: AiMailComposeUndoRequest): Promise<AiMailComposeMutationResult>
  applySubject(request: AiMailComposeApplyRequest): Promise<AiMailComposeMutationResult>
  undoSubject(request: AiMailComposeUndoRequest): Promise<AiMailComposeMutationResult>
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
  const candidateIds = new Map<string, { composeId: string; lastUsedAt: number; title: string }>()
  let disposed = false
  let generation = 0
  let navListener:
    ((event: Electron.Event, url: string, inPlace: boolean, mainFrame: boolean) => void) | null =
    null
  let destroyedListener: (() => void) | null = null
  const resultLeases = new WeakMap<object, ComposeLease>()
  const snapshotLeases = new Map<string, { lease: ComposeLease; body: string; subject: string }>()
  const applyRecords = new Map<
    string,
    { lease: ComposeLease; originalBody: string; appliedBody: string }
  >()
  const confirmedBodies = new Map<
    string,
    { operation: 'apply' | 'undo'; leaseId: string; lease: ComposeLease; body: string }
  >()
  const confirmedSubjects = new Map<
    string,
    { operation: 'apply' | 'undo'; leaseId: string; lease: ComposeLease; subject: string }
  >()
  const subjectApplyRecords = new Map<
    string,
    { lease: ComposeLease; originalSubject: string; appliedSubject: string }
  >()
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
    candidateIds.clear()
    snapshotLeases.clear()
    applyRecords.clear()
    confirmedBodies.clear()
    confirmedSubjects.clear()
    subjectApplyRecords.clear()
    navListener = null
    destroyedListener = null
  }

  function current(): Context | null {
    if (
      disposed ||
      options.window.isDestroyed() ||
      options.window.isMinimized() ||
      !options.window.isVisible()
    )
      return null
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
      for (const candidate of value.targets ?? []) {
        const previous = candidateIds.get(candidate.targetId)
        candidateIds.set(candidate.targetId, {
          composeId: previous?.composeId ?? randomUUID(),
          lastUsedAt: candidate.lastUsedAt,
          title: candidate.title
        })
      }
      for (const targetId of candidateIds.keys())
        if (!(value.targets ?? []).some((candidate) => candidate.targetId === targetId))
          candidateIds.delete(targetId)
      if (!value.targetId || !value.snapshot) {
        if (value.unsupported) {
          selectedId = null
          selectedDomId = null
          return { status: 'unsupported', result: value, ctx: capturedContext }
        }
        selectedId = null
        selectedDomId = null
        return { status: 'none', result: value, ctx: capturedContext }
      }
      if (value.targetId !== selectedDomId) {
        selectedDomId = value.targetId
        selectedId = candidateIds.get(value.targetId)?.composeId ?? randomUUID()
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
    const candidatesFor = (pageResult?: PageResult): ComposeCandidate[] =>
      (pageResult?.targets ?? [])
        .map((candidate) => {
          const identity = candidateIds.get(candidate.targetId)
          return identity
            ? {
                composeId: identity.composeId,
                label: identity.title,
                lastUsedAt: identity.lastUsedAt
              }
            : null
        })
        .filter((candidate): candidate is ComposeCandidate => candidate !== null)
    if (captured.status !== 'ready') {
      if (captured.status === 'unsupported')
        return {
          status: 'unsupported',
          code: 'unsupported_content',
          ...(captured.result ? { candidates: candidatesFor(captured.result) } : {}),
          ...(captured.result?.discovery ? { discovery: captured.result.discovery } : {})
        }
      if (captured.status === 'none') {
        return {
          status: 'none',
          candidates: candidatesFor(captured.result),
          ...(captured.result?.discovery ? { discovery: captured.result.discovery } : {})
        }
      }
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
    const candidates = candidatesFor(capturedResult)
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
      const status = {
        status: 'ready' as const,
        ...metadata,
        candidates,
        ...(capturedResult.discovery ? { discovery: capturedResult.discovery } : {})
      }
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
      body: capturedResult.snapshot.body,
      candidates,
      ...(capturedResult.discovery ? { discovery: capturedResult.discovery } : {})
    }
    resultLeases.set(snapshotResult, lease)
    snapshotLeases.set(snapshotResult.snapshotId, {
      lease,
      body: capturedResult.snapshot.body,
      subject: capturedResult.snapshot.subject
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
      selectedId === lease.composeId &&
      selectedDomId === lease.targetId &&
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
    operation: 'apply' | 'undo',
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
        currentVersion: rememberConflict(operation, leaseId, lease, latest.snapshot.body),
        currentBody: latest.snapshot.body
      }
    if (!leaseIsCurrent(lease)) return { status: 'stale_target' }
    const result = await replace(lease, expectedBody, replacement)
    return result ?? { status: 'stale_target' }
  }

  function rememberConflict(
    operation: 'apply' | 'undo',
    leaseId: string,
    lease: ComposeLease,
    body: string
  ): string {
    const currentVersion = randomUUID()
    confirmedBodies.set(currentVersion, { operation, leaseId, lease, body })
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
    const confirmedVersion = request.confirmedCurrentVersion
    const confirmation = confirmedVersion ? confirmedBodies.get(confirmedVersion) : undefined
    if (confirmedVersion) confirmedBodies.delete(confirmedVersion)
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
        if (
          confirmedVersion &&
          (!confirmation ||
            confirmation.operation !== 'apply' ||
            confirmation.leaseId !== request.snapshotId ||
            confirmation.lease !== lease)
        )
          return { status: 'stale_target' }
        const replacement = request.replacement.replace(/\r\n?/g, '\n')
        const result = await compareAndReplace(
          lease,
          'apply',
          request.snapshotId,
          confirmation?.body ?? snapshot.body,
          replacement
        )
        if (result.status === 'conflict') {
          if ('currentVersion' in result) return result
          if (typeof result.body === 'string')
            return {
              status: 'conflict',
              currentVersion: rememberConflict('apply', request.snapshotId, lease, result.body),
              currentBody: result.body
            }
          return { status: 'stale_target' }
        }
        if (result.status !== 'applied')
          return { status: result.status === 'unsupported' ? 'unsupported' : 'stale_target' }
        const applyId = randomUUID()
        applyRecords.set(applyId, {
          lease,
          originalBody: confirmation?.body ?? snapshot.body,
          appliedBody: replacement
        })
        if (applyRecords.size > 32) {
          const oldest = applyRecords.keys().next().value
          if (oldest) applyRecords.delete(oldest)
        }
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
      if (
        confirmedVersion &&
        (!confirmation ||
          confirmation.operation !== 'undo' ||
          confirmation.leaseId !== request.applyId ||
          confirmation.lease !== lease)
      )
        return { status: 'stale_target' }
      const result = await compareAndReplace(
        lease,
        'undo',
        request.applyId,
        confirmation?.body ?? record.appliedBody,
        record.originalBody
      )
      if (result.status === 'conflict') {
        if ('currentVersion' in result) return result
        if (typeof result.body === 'string')
          return {
            status: 'conflict',
            currentVersion: rememberConflict('undo', request.applyId, lease, result.body),
            currentBody: result.body
          }
        return { status: 'stale_target' }
      }
      if (result.status !== 'applied')
        return { status: result.status === 'unsupported' ? 'unsupported' : 'stale_target' }
      applyRecords.delete(request.applyId)
      return { status: 'undone' }
    } finally {
      mutationInFlight = false
    }
  }

  async function mutateSubject(
    request: AiMailComposeApplyRequest | AiMailComposeUndoRequest,
    operation: 'apply' | 'undo'
  ): Promise<AiMailComposeMutationResult> {
    if ((operation === 'apply') !== 'snapshotId' in request) return { status: 'stale_target' }
    if (mutationInFlight) return { status: 'busy' }
    mutationInFlight = true
    try {
      const confirmedVersion = request.confirmedCurrentVersion
      const confirmation = confirmedVersion ? confirmedSubjects.get(confirmedVersion) : undefined
      if (confirmedVersion) confirmedSubjects.delete(confirmedVersion)
      let lease: ComposeLease | undefined
      let leaseId: string
      let expected: string
      let replacement: string
      if ('snapshotId' in request) {
        leaseId = request.snapshotId
        const snapshot = snapshotLeases.get(leaseId)
        lease = snapshot?.lease
        if (
          !snapshot ||
          !lease ||
          request.accountId !== lease.accountId ||
          request.composeId !== lease.composeId ||
          request.documentVersion !== lease.documentVersion ||
          !leaseIsCurrent(lease)
        )
          return { status: 'stale_target' }
        expected = snapshotLeases.get(leaseId)?.subject ?? ''
        replacement = request.replacement
        if (replacement.length > MAX_SUBJECT_LENGTH) return { status: 'unsupported' }
      } else {
        leaseId = request.applyId
        const record = subjectApplyRecords.get(leaseId)
        lease = record?.lease
        if (
          !record ||
          !lease ||
          request.accountId !== lease.accountId ||
          request.composeId !== lease.composeId ||
          request.documentVersion !== lease.documentVersion ||
          !leaseIsCurrent(lease)
        )
          return { status: 'stale_target' }
        expected = record.appliedSubject
        replacement = record.originalSubject
      }
      if (
        !lease ||
        (confirmedVersion &&
          (confirmation?.operation !== operation ||
            confirmation.leaseId !== leaseId ||
            confirmation.lease !== lease))
      )
        return { status: 'stale_target' }
      const value = await execute(
        lease.contents,
        `globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(lease.probeDocumentId)} ? globalThis.__hantongComposeTarget.replaceSubject(${JSON.stringify(lease.targetId)}, ${JSON.stringify(confirmation?.subject ?? expected)}, ${JSON.stringify(replacement)}) : null`
      )
      if (!leaseIsCurrent(lease) || !validPageReplaceResult(value))
        return { status: 'stale_target' }
      if (value.status === 'conflict' && typeof value.body === 'string') {
        const currentVersion = randomUUID()
        confirmedSubjects.set(currentVersion, { operation, leaseId, lease, subject: value.body })
        if (confirmedSubjects.size > 32)
          confirmedSubjects.delete(confirmedSubjects.keys().next().value as string)
        return { status: 'conflict', currentVersion, currentBody: value.body }
      }
      if (value.status !== 'applied')
        return { status: value.status === 'unsupported' ? 'unsupported' : 'stale_target' }
      if (operation === 'apply') {
        const applyId = randomUUID()
        subjectApplyRecords.set(applyId, {
          lease,
          originalSubject: confirmation?.subject ?? expected,
          appliedSubject: replacement
        })
        if (subjectApplyRecords.size > 32) {
          const oldest = subjectApplyRecords.keys().next().value
          if (oldest) subjectApplyRecords.delete(oldest)
        }
        const snapshot = snapshotLeases.get(leaseId)
        if (snapshot) snapshotLeases.set(leaseId, { ...snapshot, subject: replacement })
        return { status: 'applied', applyId }
      }
      subjectApplyRecords.delete(leaseId)
      for (const [id, snapshot] of snapshotLeases)
        if (snapshot.lease === lease) snapshotLeases.set(id, { ...snapshot, subject: replacement })
      return { status: 'undone' }
    } catch {
      return { status: 'failed' }
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
    async selectTarget(request) {
      if (request.accountId !== current()?.accountId) return { status: 'stale' }
      const target = [...candidateIds.entries()].find(
        ([, identity]) => identity.composeId === request.composeId
      )
      if (!target) return { status: 'stale' }
      const [targetId] = target
      const ctx = context
      const localDocumentId = documentId
      const localGeneration = generation
      if (!ctx || !localDocumentId) return { status: 'stale' }
      try {
        const selected = await execute(
          ctx.contents,
          `globalThis.__hantongComposeTarget?.documentId === ${JSON.stringify(localDocumentId)} ? globalThis.__hantongComposeTarget.selectTarget(${JSON.stringify(targetId)}) : false`
        )
        if (
          selected !== true ||
          generation !== localGeneration ||
          !leaseIsCurrent({
            generation: localGeneration,
            accountId: ctx.accountId,
            composeId: request.composeId,
            targetId,
            contents: ctx.contents,
            lifecycleVersion: ctx.lifecycleVersion,
            documentVersion: ctx.documentVersion,
            probeDocumentId: localDocumentId
          })
        )
          return { status: 'stale' }
        selectedDomId = targetId
        selectedId = request.composeId
        return await this.getSnapshot()
      } catch {
        return { status: 'stale' }
      }
    },
    applyDraft(request) {
      return mutate(request, 'apply')
    },
    undoDraft(request) {
      return mutate(request, 'undo')
    },
    async applySubject(request) {
      return mutateSubject(request, 'apply')
    },
    async undoSubject(request) {
      return mutateSubject(request, 'undo')
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
