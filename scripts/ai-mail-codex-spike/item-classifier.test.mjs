import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyThreadItem, matchesThreadTurn } from './item-classifier.mjs'

test('protocol content items are not mistaken for tool calls', () => {
  for (const type of [
    'userMessage',
    'hookPrompt',
    'agentMessage',
    'plan',
    'reasoning',
    'contextCompaction'
  ]) {
    assert.deepEqual(classifyThreadItem({ type }), { classification: 'non_tool', type })
  }
})

test('privileged tool item variants are detected', () => {
  for (const type of [
    'commandExecution',
    'fileChange',
    'functionCallOutput',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'subAgentActivity',
    'webSearch',
    'imageView',
    'imageGeneration',
    'sleep'
  ]) {
    assert.deepEqual(classifyThreadItem({ type }), { classification: 'tool', type })
  }
})

test('unknown or malformed item types fail closed without echoing payload data', () => {
  assert.deepEqual(classifyThreadItem({ type: 'unexpected', text: 'private content' }), {
    classification: 'unknown',
    type: null
  })
  assert.deepEqual(classifyThreadItem(null), { classification: 'unknown', type: null })
})

test('thread turn notifications match both flat and nested turn ID schemas', () => {
  assert.equal(matchesThreadTurn({ threadId: 't', turnId: 'u' }, 't', 'u'), true)
  assert.equal(matchesThreadTurn({ threadId: 't', turn: { id: 'u' } }, 't', 'u'), true)
  assert.equal(matchesThreadTurn({ threadId: 't', turn: { id: 'other' } }, 't', 'u'), false)
  assert.equal(matchesThreadTurn({ turn: { id: 'u' } }, 't', 'u'), false)
})
