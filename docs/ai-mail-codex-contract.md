# #37 Codex caller contract

The future #38 panel calls only the typed `window.api` methods below. Status is
currently `{ state: 'unsupported', reason: 'product_owned_executable_unavailable' }`;
connect and disconnect return that status, and generation returns
`{ ok: false, error: 'unsupported', reason: 'product_owned_executable_unavailable' }`.
No Codex process is started and no prompt is transmitted in this build.

Generation accepts `{ accountId, composeId, requestId, generation, prompt,
followUp? }`. IDs are bounded ASCII identifiers; prompt is plain text, at most
4,000 characters, and follow-up at most 2,000 characters. The panel must send
only synthetic fixture text until an independently approved product flow says
otherwise. Never pass Gmail data. Account, compose, request, and generation IDs
are explicit so a later implementation can isolate work and reject stale
responses. Treat generated text as untrusted text and render it without HTML.

API methods: `getAiMailCodexStatus()`, `connectAiMailCodex()`,
`disconnectAiMailCodex()`, `generateAiMailDraft(request)`, and
`cancelAiMailGeneration(requestId)`. Cancellation currently resolves to
`{ cancelled: false, reason: 'unsupported' }`. The service is disposed during
application shutdown. This API does not grant Gmail write access or implement
compose, save, replace, undo, send, or live Gmail reads.
