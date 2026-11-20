type InlinePart = string | React.JSX.Element

function renderInlineMarkdown(source: string, keyPrefix: string): InlinePart[] {
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`[^`\n]+`|\*[^*\n]+\*|_[^_\n]+_)/g
  const parts: InlinePart[] = []
  let offset = 0

  for (const match of source.matchAll(pattern)) {
    const index = match.index
    const token = match[0]
    if (index > offset) parts.push(source.slice(offset, index))
    const key = `${keyPrefix}-${index}`
    if (token.startsWith('**') || token.startsWith('__')) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('~~')) {
      parts.push(<del key={key}>{token.slice(2, -2)}</del>)
    } else if (token.startsWith('`')) {
      parts.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    offset = index + token.length
  }

  if (offset < source.length) parts.push(source.slice(offset))
  return parts
}

export function AiMailMarkdown({
  text,
  tone
}: {
  text: string
  tone?: 'error' | 'notice'
}): React.JSX.Element {
  const blocks: React.JSX.Element[] = []
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let code: string[] | null = null

  const flushParagraph = (): void => {
    if (!paragraph.length) return
    blocks.push(
      <p key={`p-${blocks.length}`}>
        {paragraph.map((line, index) => (
          <span key={index}>
            {index > 0 && <br />}
            {renderInlineMarkdown(line, `p-${blocks.length}-${index}`)}
          </span>
        ))}
      </p>
    )
    paragraph = []
  }

  const flushList = (): void => {
    if (!list) return
    const items = list.items.map((item, index) => (
      <li key={`li-${index}`}>{renderInlineMarkdown(item, `li-${blocks.length}-${index}`)}</li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={`ol-${blocks.length}`}>{items}</ol>
      ) : (
        <ul key={`ul-${blocks.length}`}>{items}</ul>
      )
    )
    list = null
  }

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push(
          <pre key={`code-${blocks.length}`}>
            <code>{code.join('\n')}</code>
          </pre>
        )
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushParagraph()
      flushList()
      code = []
      continue
    }
    if (!line.trim()) {
      flushParagraph()
      flushList()
      continue
    }
    if (/^\s{0,3}#{1,3}\s/.test(line)) {
      flushParagraph()
      flushList()
      const heading = line.match(/^\s{0,3}(#{1,3})\s+(.*)$/)
      if (heading) {
        const content = renderInlineMarkdown(heading[2], `heading-${blocks.length}`)
        blocks.push(
          heading[1].length === 1 ? (
            <h3 key={`heading-${blocks.length}`}>{content}</h3>
          ) : (
            <h4 key={`heading-${blocks.length}`}>{content}</h4>
          )
        )
      }
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      flushParagraph()
      flushList()
      const quote = line.replace(/^\s{0,3}>\s?/, '')
      blocks.push(
        <blockquote key={`quote-${blocks.length}`}>
          {renderInlineMarkdown(quote, `quote-${blocks.length}`)}
        </blockquote>
      )
      continue
    }
    const item = line.match(/^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/)
    if (item) {
      flushParagraph()
      const ordered = Boolean(item[2])
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push(item[3])
      continue
    }
    if (list) flushList()
    paragraph.push(line)
  }

  flushParagraph()
  flushList()
  if (code) {
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{code.join('\n')}</code>
      </pre>
    )
  }

  return (
    <div
      className={`ai-mail-markdown${tone === 'error' ? ' ai-mail-markdown-error' : ''}`}
      role={tone === 'error' ? 'alert' : tone === 'notice' ? 'status' : undefined}
    >
      {blocks}
    </div>
  )
}
