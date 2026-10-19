import { useState, type DragEvent } from 'react'
import { accountLabel, type GmailAccount } from '../../shared/accounts'

interface AccountNavigationProps {
  accounts: GmailAccount[]
  activeAccountId: string | null
  unreadCounts: Record<string, number>
  locale: 'ko' | 'en'
  disabled: boolean
  addDisabled: boolean
  onActivate: (accountId: string) => void
  onAdd: () => void
  onMove: (accountId: string, toIndex: number) => void
}

interface SidebarAccountNavigationProps extends AccountNavigationProps {
  collapsed: boolean
}

interface DragProps {
  draggable: boolean
  'data-dragging'?: boolean
  'data-drop'?: 'before' | 'after'
  onDragStart: (event: DragEvent) => void
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
  onDragEnd: () => void
}

// Native HTML drag and drop; the dropped account takes the target's index.
function useAccountDrag(
  accounts: GmailAccount[],
  onMove: AccountNavigationProps['onMove'],
  disabled: boolean
): (accountId: string, index: number) => DragProps {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const fromIndex = accounts.findIndex((account) => account.id === dragId)
  const reset = (): void => {
    setDragId(null)
    setOverIndex(null)
  }
  return (accountId, index) => ({
    draggable: !disabled,
    'data-dragging': dragId === accountId || undefined,
    'data-drop':
      fromIndex >= 0 && overIndex === index && fromIndex !== index
        ? fromIndex < index
          ? 'after'
          : 'before'
        : undefined,
    onDragStart: (event) => {
      event.dataTransfer.effectAllowed = 'move'
      setDragId(accountId)
    },
    onDragOver: (event) => {
      if (!dragId) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      setOverIndex(index)
    },
    onDrop: (event) => {
      event.preventDefault()
      if (!disabled && dragId && dragId !== accountId) onMove(dragId, index)
      reset()
    },
    onDragEnd: reset
  })
}

export function AccountAvatar({
  account,
  label
}: {
  account: GmailAccount
  label: string
}): React.JSX.Element {
  return (
    <span
      className="account-avatar"
      data-account-color={account.color ?? 'blue'}
      aria-hidden="true"
    >
      {label.slice(0, 1).toLocaleUpperCase()}
    </span>
  )
}

function AccountUnreadCount({ count }: { count: number }): React.JSX.Element | null {
  if (count <= 0) return null
  return <span className="unread-badge">{count > 99 ? '99+' : count}</span>
}

function accountAriaLabel(account: GmailAccount, label: string): string {
  return `${label}${account.email && account.email !== label ? `, ${account.email}` : ''}`
}

function AddIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

// Top/bottom placement: full-height text tabs separated by dividers, like a browser tab strip.
export function AccountCardNavigation({
  accounts,
  activeAccountId,
  unreadCounts,
  locale,
  disabled,
  addDisabled,
  onActivate,
  onAdd,
  onMove
}: AccountNavigationProps): React.JSX.Element {
  const dragProps = useAccountDrag(accounts, onMove, disabled)
  return (
    <div
      className="account-tabs"
      role="group"
      aria-label={locale === 'ko' ? 'Gmail 계정' : 'Gmail accounts'}
    >
      {accounts.map((account, index) => {
        const label = accountLabel(account, index)
        return (
          <button
            className="account-tab"
            key={account.id}
            data-account-color={account.color ?? 'blue'}
            type="button"
            aria-current={account.id === activeAccountId ? 'true' : undefined}
            aria-label={accountAriaLabel(account, label)}
            title={account.email ?? label}
            disabled={disabled}
            onClick={() => onActivate(account.id)}
            {...dragProps(account.id, index)}
          >
            <span className="account-tab-name">{label}</span>
            <AccountUnreadCount count={unreadCounts[account.id] ?? 0} />
          </button>
        )
      })}
      <button
        className="account-tab-add"
        type="button"
        aria-label={locale === 'ko' ? '계정 추가' : 'Add account'}
        title={locale === 'ko' ? '계정 추가' : 'Add account'}
        disabled={addDisabled}
        onClick={onAdd}
      >
        <AddIcon />
      </button>
    </div>
  )
}

// Left/right placement: plain one-line text rows; the avatar appears only in the collapsed rail.
export function SidebarAccountNavigation({
  accounts,
  activeAccountId,
  unreadCounts,
  locale,
  collapsed,
  disabled,
  addDisabled,
  onActivate,
  onAdd,
  onMove
}: SidebarAccountNavigationProps): React.JSX.Element {
  const dragProps = useAccountDrag(accounts, onMove, disabled)
  const addLabel = locale === 'ko' ? '계정 추가' : 'Add account'
  return (
    <div
      className={`sidebar-account-list${collapsed ? ' is-collapsed' : ''}`}
      role="group"
      aria-label={locale === 'ko' ? 'Gmail 계정' : 'Gmail accounts'}
    >
      {accounts.map((account, index) => {
        const label = accountLabel(account, index)
        const unread = unreadCounts[account.id] ?? 0
        return (
          <button
            className="sidebar-account-row"
            key={account.id}
            type="button"
            aria-current={account.id === activeAccountId ? 'true' : undefined}
            aria-label={accountAriaLabel(account, label)}
            title={account.email ?? label}
            disabled={disabled}
            onClick={() => onActivate(account.id)}
            {...dragProps(account.id, index)}
          >
            {collapsed ? (
              <>
                <AccountAvatar account={account} label={label} />
                {unread > 0 && <span className="sidebar-unread-dot" aria-hidden="true" />}
              </>
            ) : (
              <>
                <span className="sidebar-account-name">{label}</span>
                <AccountUnreadCount count={unread} />
              </>
            )}
          </button>
        )
      })}
      <button
        className="sidebar-account-row sidebar-account-add"
        type="button"
        aria-label={addLabel}
        title={collapsed ? addLabel : undefined}
        disabled={addDisabled}
        onClick={onAdd}
      >
        <AddIcon />
        {!collapsed && <span className="sidebar-account-name">{addLabel}</span>}
      </button>
    </div>
  )
}
