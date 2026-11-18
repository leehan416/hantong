import type { ReactNode } from 'react'

type AiMailChatLayoutProps = {
  header: ReactNode
  context?: ReactNode
  children: ReactNode
  composer: ReactNode
}

export function AiMailChatLayout({
  header,
  context,
  children,
  composer
}: AiMailChatLayoutProps): React.JSX.Element {
  return (
    <div className="ai-mail-chat-layout">
      <header className="ai-mail-chat-header">{header}</header>
      {context != null && <div className="ai-mail-chat-context">{context}</div>}
      <div className="ai-mail-chat-messages">{children}</div>
      <div className="ai-mail-chat-composer">{composer}</div>
    </div>
  )
}
