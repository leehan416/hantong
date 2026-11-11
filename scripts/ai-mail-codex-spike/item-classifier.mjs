const TOOL_ITEM_TYPES = new Set([
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
])

const NON_TOOL_ITEM_TYPES = new Set([
  'userMessage',
  'hookPrompt',
  'agentMessage',
  'plan',
  'reasoning',
  'enteredReviewMode',
  'exitedReviewMode',
  'contextCompaction'
])

export function classifyThreadItem(item) {
  const type = typeof item?.type === 'string' ? item.type : null
  if (type && TOOL_ITEM_TYPES.has(type)) return { classification: 'tool', type }
  if (type && NON_TOOL_ITEM_TYPES.has(type)) return { classification: 'non_tool', type }
  return { classification: 'unknown', type: null }
}

export function matchesThreadTurn(params, threadId, turnId) {
  const reportedTurnId = params?.turnId ?? params?.turn?.id
  return params?.threadId === threadId && reportedTurnId === turnId
}
