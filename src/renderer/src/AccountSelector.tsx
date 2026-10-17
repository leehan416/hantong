import { useRef } from 'react'
import type { GmailAccount } from '../../shared/accounts'

interface AccountSelectorProps {
  accounts: GmailAccount[]
  activeAccountId: string | null
  unreadCounts: Record<string, number>
  locale: 'ko' | 'en'
  disabled: boolean
  addDisabled: boolean
  onActivate: (accountId: string) => void
  onAdd: () => void
}

export function AccountSelector({
  accounts,
  activeAccountId,
  unreadCounts,
  locale,
  disabled,
  addDisabled,
  onActivate,
  onAdd
}: AccountSelectorProps): React.JSX.Element {
  const disclosure = useRef<HTMLDetailsElement>(null)
  const activeAccount = accounts.find((account) => account.id === activeAccountId)
  const accountLabel = (account: GmailAccount, index: number): string =>
    account.displayName?.trim() || account.email?.trim() || `Gmail ${index + 1}`

  return (
    <details className="account-disclosure" ref={disclosure}>
      <summary
        className="account-disclosure-trigger"
        aria-label={locale === 'ko' ? '계정 선택' : 'Select account'}
      >
        <span className="account-disclosure-label">
          {activeAccount
            ? accountLabel(activeAccount, Math.max(0, accounts.indexOf(activeAccount)))
            : locale === 'ko'
              ? '계정 선택'
              : 'Select account'}
        </span>
        <span className="account-disclosure-chevron" aria-hidden="true">
          ⌄
        </span>
      </summary>
      <div
        className="account-menu"
        role="group"
        aria-label={locale === 'ko' ? 'Gmail 계정' : 'Gmail accounts'}
      >
        {accounts.map((account, index) => {
          const unread = unreadCounts[account.id] ?? 0
          return (
            <button
              className="account-menu-item"
              key={account.id}
              type="button"
              aria-current={account.id === activeAccountId ? 'true' : undefined}
              disabled={disabled}
              onClick={() => {
                disclosure.current?.removeAttribute('open')
                onActivate(account.id)
              }}
            >
              <span className="account-menu-copy">
                <span className="account-menu-name">{accountLabel(account, index)}</span>
                {account.email && account.displayName?.trim() && (
                  <span className="account-menu-email">{account.email}</span>
                )}
              </span>
              <span className="account-menu-meta">
                {unread > 0 && <span className="unread-badge">{unread > 99 ? '99+' : unread}</span>}
                {account.id === activeAccountId && <span aria-hidden="true">✓</span>}
              </span>
            </button>
          )
        })}
        <button
          className="account-menu-add"
          type="button"
          disabled={addDisabled}
          onClick={() => {
            disclosure.current?.removeAttribute('open')
            onAdd()
          }}
        >
          <span aria-hidden="true">＋</span> {locale === 'ko' ? '계정 추가' : 'Add account'}
        </button>
      </div>
    </details>
  )
}
