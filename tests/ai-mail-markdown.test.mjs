/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node's built-in test helpers use inferred values. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { AiMailMarkdown } = loadTypeScript(
  new URL(
    '../src/renderer/src/components/ai-mail/AiMailMarkdown/AiMailMarkdown.tsx',
    import.meta.url
  )
)

function elements(node, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, result)
    return result
  }
  if (!node || typeof node !== 'object') return result
  result.push(node)
  elements(node.props?.children, result)
  return result
}

function textContent(node, result = []) {
  if (Array.isArray(node)) {
    for (const child of node) textContent(child, result)
  } else if (node && typeof node === 'object') {
    textContent(node.props?.children, result)
  } else if (typeof node === 'string') {
    result.push(node)
  }
  return result.join('')
}

test('assistant markdown renders readable blocks and inline emphasis without interpreting HTML', () => {
  const tree = AiMailMarkdown({
    text: '## Next steps\n\n- **Confirm** the date\n- Keep `draftOnly`\n\n<script>alert(1)</script>'
  })
  const rendered = elements(tree)

  assert.ok(rendered.some((node) => node.type === 'h4'))
  assert.ok(rendered.some((node) => node.type === 'ul'))
  assert.ok(rendered.some((node) => node.type === 'strong'))
  assert.ok(rendered.some((node) => node.type === 'code'))
  assert.equal(
    rendered.some((node) => node.type === 'script'),
    false
  )
  assert.ok(textContent(tree).includes('<script>alert(1)</script>'))
})

test('unfinished fenced code stays readable as literal text', () => {
  const tree = AiMailMarkdown({ text: '```text\nsubject: hello\nbody: short' })
  const rendered = elements(tree)
  const pre = rendered.find((node) => node.type === 'pre')

  assert.ok(pre)
  assert.equal(pre.props.children.props.children, 'subject: hello\nbody: short')
})

test('a paragraph after a list keeps its source order without a blank line', () => {
  const tree = AiMailMarkdown({ text: '- First item\n- Second item\nFollow-up sentence.' })
  const children = tree.props.children

  assert.equal(children[0].type, 'ul')
  assert.equal(children[1].type, 'p')
})

test('error messages retain alert semantics and error styling', () => {
  const tree = AiMailMarkdown({ text: 'The draft changed.', tone: 'error' })

  assert.equal(tree.props.role, 'alert')
  assert.equal(tree.props.className, 'ai-mail-markdown ai-mail-markdown-error')
})
