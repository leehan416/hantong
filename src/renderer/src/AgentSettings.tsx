import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, AppSettingsPatch } from '../../shared/settings'
import type { CodexConnectionStatus, CodexModel, OllamaModel } from '../../shared/ipc'
import type { AppMessages } from './app-messages'
import { SettingsRow } from './SettingsDialog'

export function AgentSettings({
  settings,
  text,
  failed,
  onChange
}: {
  settings: AppSettings | null
  text: AppMessages
  failed: boolean
  onChange: (patch: AppSettingsPatch) => Promise<boolean>
}): React.JSX.Element {
  const [ollamaModels, setOllamaModels] = useState<OllamaModel[]>([])
  const [codexModels, setCodexModels] = useState<CodexModel[]>([])
  const [codexStatus, setCodexStatus] = useState<CodexConnectionStatus | null>(null)
  const [hasCredential, setHasCredential] = useState(false)
  const [credential, setCredential] = useState('')
  const [endpointDraft, setEndpointDraft] = useState<string | null>(null)
  const endpoint = endpointDraft ?? settings?.ollamaRemoteEndpoint ?? ''
  const [status, setStatus] = useState(text.aiMail.providerLoading)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [pendingProvider, setPendingProvider] = useState<AppSettings['aiMailProvider'] | null>(null)
  const activeProvider = pendingProvider ?? settings?.aiMailProvider ?? 'codex'
  const refreshSequence = useRef(0)

  const loadProviderData = useCallback(
    async (sequence: number, isCurrent: () => boolean): Promise<void> => {
      try {
        const credentialEndpoint = settings?.ollamaRemoteEndpoint ?? 'https://ollama.com/v1'
        const data =
          activeProvider === 'ollama'
            ? await Promise.all([
                window.api.getOllamaStatus(),
                window.api.getOllamaModels(),
                window.api.getOllamaCredentialStatus(credentialEndpoint)
              ])
            : await Promise.all([window.api.getAiMailCodexStatus(), window.api.getCodexModels()])
        if (!isCurrent() || refreshSequence.current !== sequence) return
        if (activeProvider === 'ollama') {
          const [ollamaStatus, models, saved] = data as [
            Awaited<ReturnType<typeof window.api.getOllamaStatus>>,
            OllamaModel[],
            boolean
          ]
          setOllamaModels(models)
          setHasCredential(saved)
          setStatus(
            ollamaStatus.state === 'available'
              ? settings?.ollamaMode === 'remote'
                ? text.agentRemoteReady
                : text.aiMail.ollamaReady
              : text.aiMail.ollamaUnavailable
          )
        } else {
          const [codex, inventory] = data as [
            CodexConnectionStatus,
            Awaited<ReturnType<typeof window.api.getCodexModels>>
          ]
          setCodexStatus(codex)
          setCodexModels(inventory.state === 'available' ? inventory.models : [])
          setStatus(text.aiMail[codex.state === 'connected' ? 'connected' : 'disconnected'])
        }
      } catch {
        if (!isCurrent() || refreshSequence.current !== sequence) return
        setError(true)
        setStatus(text.aiMail.providerError)
      } finally {
        if (isCurrent() && refreshSequence.current === sequence) setBusy(false)
      }
    },
    [settings, text, activeProvider]
  )

  async function refresh(): Promise<void> {
    const sequence = ++refreshSequence.current
    setBusy(true)
    setError(false)
    await loadProviderData(sequence, () => refreshSequence.current === sequence)
  }

  useEffect(() => {
    const sequence = ++refreshSequence.current
    let active = true
    const unsubscribe = window.api.onAiMailCodexStatus(setCodexStatus)
    void loadProviderData(sequence, () => active)
    return () => {
      active = false
      unsubscribe()
    }
  }, [
    loadProviderData,
    settings?.ollamaMode,
    settings?.ollamaRemoteEndpoint,
    settings?.aiMailProvider,
    activeProvider
  ])

  async function save(patch: AppSettingsPatch): Promise<boolean> {
    setBusy(true)
    setError(false)
    try {
      const saved = await onChange(patch)
      if (!saved) setError(true)
      return saved
    } catch {
      setError(true)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function changeProvider(provider: AppSettings['aiMailProvider']): Promise<void> {
    if (!settings || busy) return
    const hasModel =
      settings.ollamaMode === 'remote' ? settings.ollamaRemoteModel : settings.ollamaModel
    if (provider === 'ollama' && !hasModel) {
      setPendingProvider('ollama')
      return
    }
    if (await save({ aiMailProvider: provider })) setPendingProvider(null)
  }

  async function changeModel(value: string): Promise<void> {
    if (!settings) return
    const model = value || null
    const patch: AppSettingsPatch =
      settings.ollamaMode === 'remote' ? { ollamaRemoteModel: model } : { ollamaModel: model }
    if (pendingProvider && model) patch.aiMailProvider = pendingProvider
    if (await save(patch)) setPendingProvider(null)
  }

  async function storeCredential(): Promise<void> {
    if (!credential.trim() || busy) return
    setBusy(true)
    setError(false)
    try {
      await window.api.setOllamaCredential(endpoint, credential.trim())
      setCredential('')
      setHasCredential(true)
      await refresh()
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  async function removeCredential(): Promise<void> {
    setBusy(true)
    setError(false)
    try {
      await window.api.clearOllamaCredential(endpoint)
      setHasCredential(false)
      setCredential('')
      setBusy(false)
    } catch {
      setError(true)
      setBusy(false)
    }
  }

  async function changeCodexConnection(action: 'connect' | 'disconnect'): Promise<void> {
    setBusy(true)
    setError(false)
    try {
      const next =
        action === 'connect'
          ? await window.api.connectAiMailCodex()
          : await window.api.disconnectAiMailCodex()
      setCodexStatus(next)
      const inventory = await window.api.getCodexModels()
      setCodexModels(inventory.state === 'available' ? inventory.models : [])
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  const selectedOllamaModel =
    settings?.ollamaMode === 'remote' ? settings.ollamaRemoteModel : settings?.ollamaModel

  return (
    <div
      id="settings-panel-agent"
      role="tabpanel"
      aria-labelledby="settings-tab-agent"
      className="settings-tab-panel"
    >
      <SettingsRow label={text.agentProvider}>
        <select
          className="settings-select"
          value={settings?.aiMailProvider ?? 'codex'}
          disabled={!settings || busy}
          onChange={(event) =>
            void changeProvider(event.target.value as AppSettings['aiMailProvider'])
          }
        >
          <option value="codex">{text.agentCodex}</option>
          <option value="ollama">{text.agentOllama}</option>
        </select>
      </SettingsRow>

      {activeProvider === 'ollama' && (
        <SettingsRow label={text.agentMode}>
          <select
            className="settings-select"
            value={settings?.ollamaMode ?? 'local'}
            disabled={!settings || busy}
            onChange={(event) =>
              void save({ ollamaMode: event.target.value as AppSettings['ollamaMode'] })
            }
          >
            <option value="local">{text.agentLocal}</option>
            <option value="remote">{text.agentRemote}</option>
          </select>
        </SettingsRow>
      )}

      {activeProvider === 'ollama' && settings?.ollamaMode === 'remote' && (
        <>
          <SettingsRow label={text.agentEndpoint}>
            <input
              className="settings-select"
              type="url"
              value={endpoint}
              disabled={busy}
              onChange={(event) => setEndpointDraft(event.target.value)}
              onBlur={() => {
                if (endpoint !== settings.ollamaRemoteEndpoint)
                  void save({ ollamaRemoteEndpoint: endpoint }).then((saved) => {
                    if (saved) setEndpointDraft(null)
                  })
              }}
            />
          </SettingsRow>
          <SettingsRow label={text.agentApiKey}>
            <input
              className="settings-select"
              type="password"
              autoComplete="new-password"
              value={credential}
              disabled={busy}
              onChange={(event) => setCredential(event.target.value)}
            />
            <button
              className="settings-text-button"
              type="button"
              disabled={busy || !credential.trim()}
              onClick={() => void storeCredential()}
            >
              {text.agentSaveKey}
            </button>
            {hasCredential && (
              <button
                className="settings-text-button"
                type="button"
                disabled={busy}
                onClick={() => void removeCredential()}
              >
                {text.agentRemoveKey}
              </button>
            )}
          </SettingsRow>
          <p className="ai-mail-provider-note">
            {hasCredential ? text.agentKeySaved : text.agentRemoteRequiresKey}
          </p>
        </>
      )}

      {activeProvider === 'ollama' && (
        <SettingsRow label={`${text.agentOllama} · ${text.agentModel}`}>
          <select
            className="settings-select"
            value={selectedOllamaModel ?? ''}
            disabled={busy || ollamaModels.length === 0}
            onChange={(event) => void changeModel(event.target.value)}
          >
            <option value="">{text.aiMail.chooseModel}</option>
            {ollamaModels.map((model) => (
              <option key={model.name} value={model.name}>
                {model.name}
              </option>
            ))}
          </select>
        </SettingsRow>
      )}

      {activeProvider === 'codex' && settings && (
        <SettingsRow label={`${text.agentCodex} · ${text.agentModel}`}>
          <>
            <select
              className="settings-select"
              value={settings.codexModel ?? ''}
              disabled={busy || codexModels.length === 0}
              onChange={(event) => void save({ codexModel: event.target.value || null })}
            >
              <option value="">{text.aiMail.chooseModel}</option>
              {codexModels.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </>
        </SettingsRow>
      )}

      {activeProvider === 'codex' && (
        <section className="ai-mail-connection" aria-label={text.agentCodex}>
          <span
            className={`ai-mail-connection-dot ai-mail-state-${codexStatus?.state ?? 'checking'}`}
            aria-hidden="true"
          />
          <div className="ai-mail-connection-copy">
            <strong>
              {
                text.aiMail[
                  codexStatus?.state === 'connected'
                    ? 'connected'
                    : codexStatus?.state === 'connecting'
                      ? 'connecting'
                      : 'disconnected'
                ]
              }
            </strong>
            <p>{text.agentCodexNote}</p>
          </div>
          {codexStatus?.state === 'connected' ? (
            <button
              className="ai-mail-text-button"
              type="button"
              disabled={busy}
              onClick={() => void changeCodexConnection('disconnect')}
            >
              {text.aiMail.disconnect}
            </button>
          ) : (
            <button
              className="ai-mail-text-button"
              type="button"
              disabled={busy || codexStatus?.state === 'unsupported'}
              onClick={() => void changeCodexConnection('connect')}
            >
              {text.aiMail.connect}
            </button>
          )}
        </section>
      )}

      <div className="settings-row" role="status">
        <span className="settings-row-label">
          {text.agentStatus}: {status}
        </span>
        <button
          className="settings-text-button"
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {text.agentRefresh}
        </button>
      </div>
      {(failed || error) && (
        <p className="settings-error" role="alert">
          {text.settingsError}
        </p>
      )}
    </div>
  )
}
