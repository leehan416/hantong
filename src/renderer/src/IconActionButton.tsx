import { forwardRef, type ButtonHTMLAttributes } from 'react'

type IconAction =
  'settings' | 'sidebar-collapse' | 'sidebar-expand' | 'ai' | 'history' | 'new-chat' | 'close'

interface IconActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  action: IconAction
}

const icons: Record<IconAction, React.JSX.Element> = {
  settings: (
    <>
      <path d="M19.03 10.43 L21.42 10.77 L21.42 13.23 L19.03 13.57 L18.08 15.86 L19.53 17.79 L17.79 19.53 L15.86 18.08 L13.57 19.03 L13.23 21.42 L10.77 21.42 L10.43 19.03 L8.14 18.08 L6.21 19.53 L4.47 17.79 L5.92 15.86 L4.97 13.57 L2.58 13.23 L2.58 10.77 L4.97 10.43 L5.92 8.14 L4.47 6.21 L6.21 4.47 L8.14 5.92 L10.43 4.97 L10.77 2.58 L13.23 2.58 L13.57 4.97 L15.86 5.92 L17.79 4.47 L19.53 6.21 L18.08 8.14Z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'sidebar-collapse': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 9l-3 3 3 3" />
    </>
  ),
  'sidebar-expand': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16m3-7 3 3-3 3" />
    </>
  ),
  ai: (
    <>
      <path d="M11 4.5 12.6 9.4 17.5 11 12.6 12.6 11 17.5 9.4 12.6 4.5 11 9.4 9.4Z" />
      <path d="M18 3.5v3M16.5 5h3M18 16.5v3M16.5 18h3" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 1 0 2.35-5.65L4 8.7" />
      <path d="M4 4v4.7h4.7M12 8v4l2.8 2" />
    </>
  ),
  'new-chat': (
    <>
      <path d="M20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
      <path d="m17.5 3.5 3 3L12 15l-4 1 1-4Z" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />
}

export const IconActionButton = forwardRef<HTMLButtonElement, IconActionButtonProps>(
  function IconActionButton({ action, className = '', onClick, ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        className={`icon-action-button ${className}`.trim()}
        onClick={onClick}
        type="button"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {icons[action]}
        </svg>
      </button>
    )
  }
)
