import { forwardRef, type ButtonHTMLAttributes } from 'react'

type IconAction = 'settings' | 'sidebar-collapse' | 'sidebar-expand'

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
  )
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
