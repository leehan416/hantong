import type { WebContentsView } from 'electron'

export interface ViewHandle {
  view: WebContentsView
  load: () => Promise<void>
  revokeMailAccess: () => void
  dispose: () => Promise<void>
}

export interface ViewEntry {
  handle: ViewHandle
  loaded: boolean
  loading: boolean
  attached: boolean
  blocked: boolean
  loadNumber: number
  timeout: ReturnType<typeof setTimeout> | null
  disposePromise: Promise<void> | null
  navigationRevision: number
  accessRevision: number
  mainFrameNavigationPending: boolean
  pendingMainFrameKind: GmailDocumentState['kind'] | null
  mainFrameDocumentLoaded: boolean
  mailAccessGranted: boolean
  committedUrl: string
}

export interface GmailDocumentState {
  revision: number
  kind: 'sign_in' | 'mail' | 'unknown'
  ready: boolean
}
