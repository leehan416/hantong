/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JavaScript test helper. */
import assert from 'node:assert/strict'

export const ALLOWED_API_OPERATIONS = Object.freeze([
  'getAiMailReadSnapshot',
  'isAiMailReadSnapshotCurrent',
  'applyAiMailSubject',
  'undoAiMailSubject',
  'getAiMailComposeTargetStatus',
  'getAiMailComposeSnapshot',
  'applyAiMailDraft',
  'undoAiMailDraft',
  'onAiMailComposeTarget',
  'getAiMailCodexStatus',
  'connectAiMailCodex',
  'disconnectAiMailCodex',
  'generateAiMailDraft',
  'generateAiMailWithOllama',
  'cancelAiMailOllamaGeneration',
  'cancelAiMailGeneration',
  'onAiMailCodexStatus',
  'getOllamaStatus',
  'getOllamaModels',
  'getCodexModels',
  'getLoginLaunchState',
  'setLoginLaunchEnabled',
  'getAppInfo',
  'getGoogleConnectionStatus',
  'connectGoogleAccount',
  'cancelGoogleConnection',
  'disconnectGoogleAccount',
  'getAccounts',
  'addAccount',
  'removeAccount',
  'activateAccount',
  'setAccountDisplayName',
  'updateAccountColor',
  'setAccountNotificationsEnabled',
  'moveAccount',
  'retryAccount',
  'onAccountViewStatus',
  'onAccountState',
  'getUnreadCounts',
  'onUnreadCounts',
  'getSettings',
  'updateSettings',
  'setSettingsPanelOpen',
  'setStatusStripVisible',
  'setAiMailPanelOpen',
  'onOpenSettings',
  'onSettings',
  'getAccountAccessState',
  'onAccountAccessState',
  'getNotificationConnections',
  'onNotificationConnections',
  'recoverNotifications',
  'cancelNotificationRecovery',
  'retryNotifications'
])

export function assertAllowedApiOperations(actual) {
  assert.equal(actual.length, new Set(actual).size, 'API contains duplicate operations')
  assert.equal(actual.length, ALLOWED_API_OPERATIONS.length, 'API operation count differs')
  assert.deepEqual(
    new Set(actual),
    new Set(ALLOWED_API_OPERATIONS),
    'API operations differ from the allowed contract'
  )
}
