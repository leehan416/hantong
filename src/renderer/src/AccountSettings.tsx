import type { MutableRefObject, Dispatch, SetStateAction } from 'react'
import type { AccountState } from '../../shared/accounts'
import { ACCOUNT_COLOR_OPTIONS, accountLabel } from '../../shared/accounts'
import type { AppMessages } from './app-messages'
import { SettingsRow } from './SettingsDialog'

export function AccountSettings({
  accounts,
  text,
  accountActionsBusy,
  accountNameDrafts,
  setAccountNameDrafts,
  accountSettingsBusy,
  setAccountSettingsBusy,
  accountSettingsFailed,
  setAccountSettingsFailed,
  accountNameSaveFailed,
  setAccountNameSaveFailed,
  editingAccountId,
  setEditingAccountId,
  nameEditCancelledRef,
  accountLimitReached,
  onAdd,
  onRemove,
  onAccountsChange
}: {
  accounts: AccountState | null
  text: AppMessages
  accountActionsBusy: boolean
  accountNameDrafts: Record<string, string>
  setAccountNameDrafts: Dispatch<SetStateAction<Record<string, string>>>
  accountSettingsBusy: string | null
  setAccountSettingsBusy: Dispatch<SetStateAction<string | null>>
  accountSettingsFailed: boolean
  setAccountSettingsFailed: Dispatch<SetStateAction<boolean>>
  accountNameSaveFailed: boolean
  setAccountNameSaveFailed: Dispatch<SetStateAction<boolean>>
  editingAccountId: string | null
  setEditingAccountId: Dispatch<SetStateAction<string | null>>
  nameEditCancelledRef: MutableRefObject<boolean>
  accountLimitReached: boolean
  onAdd: () => void
  onRemove: (accountId: string) => void
  onAccountsChange: (state: AccountState) => void
}): React.JSX.Element {
  return (
    <div
      id="settings-panel-accounts"
      role="tabpanel"
      aria-labelledby="settings-tab-accounts"
      className="settings-tab-panel"
    >
      {accountSettingsFailed && (
        <p className="settings-error" role="alert">
          {text.accountActionError}
        </p>
      )}
      {accountNameSaveFailed && (
        <p className="settings-error" role="alert">
          {text.accountSaveError}
        </p>
      )}
      {accounts?.accounts.length ? (
        accounts.accounts.map((account, index) => {
          const accountName = accountLabel(account, index)
          const locked = accountSettingsBusy !== null || accountActionsBusy
          return (
            <section key={account.id} aria-label={accountName}>
              <h3 className="settings-group-title">
                {editingAccountId === account.id ? (
                  <input
                    className="settings-input settings-name-input"
                    type="text"
                    autoFocus
                    value={accountNameDrafts[account.id] ?? account.displayName ?? ''}
                    placeholder={account.email ?? text.accountNamePlaceholder}
                    maxLength={80}
                    aria-label={`${text.accountName}: ${account.email ?? accountName}`}
                    onChange={(event) =>
                      setAccountNameDrafts((drafts) => ({
                        ...drafts,
                        [account.id]: event.target.value
                      }))
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        nameEditCancelledRef.current = true
                      }
                      if (event.key === 'Enter' || event.key === 'Escape') {
                        event.currentTarget.blur()
                      }
                    }}
                    onBlur={() => {
                      const value = accountNameDrafts[account.id]
                      const cancelled = nameEditCancelledRef.current
                      nameEditCancelledRef.current = false
                      setEditingAccountId(null)
                      setAccountNameDrafts((drafts) => {
                        const next = { ...drafts }
                        delete next[account.id]
                        return next
                      })
                      if (cancelled || value === undefined || value === (account.displayName ?? ''))
                        return
                      setAccountSettingsBusy(account.id)
                      setAccountNameSaveFailed(false)
                      void window.api
                        .setAccountDisplayName(account.id, value.trim() || null)
                        .then(onAccountsChange, () => setAccountNameSaveFailed(true))
                        .finally(() => setAccountSettingsBusy(null))
                    }}
                  />
                ) : (
                  <>
                    {accountName}
                    {account.email && account.email !== accountName && (
                      <small>{account.email}</small>
                    )}
                    <span className="settings-group-actions">
                      <button
                        className="settings-text-button"
                        type="button"
                        aria-label={`${text.editName}: ${accountName}`}
                        disabled={locked}
                        onClick={() => setEditingAccountId(account.id)}
                      >
                        {text.editName}
                      </button>
                      <button
                        className="settings-text-button settings-button-danger"
                        type="button"
                        aria-label={`${text.remove}: ${accountName}`}
                        disabled={locked}
                        onClick={() => onRemove(account.id)}
                      >
                        {text.removeAction}
                      </button>
                    </span>
                  </>
                )}
              </h3>
              <div className="settings-row" role="group" aria-label={text.accountColor}>
                <span className="settings-row-label">{text.accountColor}</span>
                <div className="color-swatches">
                  {ACCOUNT_COLOR_OPTIONS.map((color) => (
                    <button
                      key={color}
                      className="color-swatch"
                      type="button"
                      data-account-color={color}
                      aria-label={text.accountColors[color]}
                      aria-pressed={(account.color ?? 'blue') === color}
                      title={text.accountColors[color]}
                      disabled={locked}
                      onClick={() => {
                        if ((account.color ?? 'blue') === color) return
                        setAccountSettingsBusy(account.id)
                        setAccountSettingsFailed(false)
                        void window.api
                          .updateAccountColor(account.id, color)
                          .then(onAccountsChange, () => setAccountSettingsFailed(true))
                          .finally(() => setAccountSettingsBusy(null))
                      }}
                    />
                  ))}
                </div>
              </div>
              <SettingsRow label={text.notificationsEnabled}>
                <input
                  className="settings-switch"
                  type="checkbox"
                  role="switch"
                  checked={account.notificationsEnabled !== false}
                  disabled={locked}
                  onChange={(event) => {
                    setAccountSettingsBusy(account.id)
                    setAccountSettingsFailed(false)
                    void window.api
                      .setAccountNotificationsEnabled(account.id, event.target.checked)
                      .then(onAccountsChange, () => setAccountSettingsFailed(true))
                      .finally(() => setAccountSettingsBusy(null))
                  }}
                />
              </SettingsRow>
            </section>
          )
        })
      ) : (
        <p className="settings-empty-accounts">{accounts ? text.noAccounts : text.pending}</p>
      )}
      <button
        className="settings-add-account"
        type="button"
        disabled={accountActionsBusy || accounts === null}
        onClick={onAdd}
      >
        <span aria-hidden="true">+</span>
        {text.add}
      </button>
      {accountLimitReached && (
        <p className="settings-error" role="alert">
          {text.accountLimit}
        </p>
      )}
    </div>
  )
}
