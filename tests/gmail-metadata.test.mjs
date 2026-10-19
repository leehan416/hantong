/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const {
  GmailMetadataFailure,
  fetchGmailHistoryId,
  fetchGmailHistoryPage,
  fetchGmailMessageSummary,
  fetchGmailUnreadCount
} = loadTypeScript(new URL('../src/main/gmail-metadata.ts', import.meta.url))

function options(fetch, signal = new AbortController().signal, timeoutMs) {
  return { fetch, signal, timeoutMs }
}

function response(status, body, extra = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    redirected: false,
    json: async () => body,
    ...extra
  }
}

test('unread count uses fixed Gmail origin, authorization header, and narrow fields', async () => {
  let request
  const count = await fetchGmailUnreadCount(
    'token-value',
    'INBOX',
    options(async (url, init) => {
      request = { url, init }
      return response(200, { id: 'INBOX', messagesUnread: 7, messagesTotal: 99 })
    })
  )

  assert.equal(count, 7)
  assert.equal(
    request.url,
    'https://gmail.googleapis.com/gmail/v1/users/me/labels/INBOX?fields=id%2CmessagesUnread'
  )
  assert.equal(request.init.method, 'GET')
  assert.equal(request.init.headers.Authorization, 'Bearer token-value')
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.signal instanceof AbortSignal, true)
})

test('unread count rejects a mismatched label and unsafe or negative counts', async () => {
  for (const body of [
    { id: 'UNREAD', messagesUnread: 2 },
    { id: 'INBOX', messagesUnread: -1 },
    { id: 'INBOX', messagesUnread: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'INBOX', messagesUnread: '2' },
    { id: 'INBOX' }
  ]) {
    await assert.rejects(
      fetchGmailUnreadCount(
        'token',
        'INBOX',
        options(async () => response(200, body))
      ),
      (error) => error instanceof GmailMetadataFailure && error.code === 'invalid_response'
    )
  }
})

test('zero unread count is accepted and invalid labels reject before fetch', async () => {
  let calls = 0
  assert.equal(
    await fetchGmailUnreadCount(
      'token',
      'UNREAD',
      options(async () => {
        calls += 1
        return response(200, { id: 'UNREAD', messagesUnread: 0 })
      })
    ),
    0
  )
  await assert.rejects(
    fetchGmailUnreadCount(
      'token',
      'SPAM',
      options(async () => {
        calls += 1
        return response(200, {})
      })
    )
  )
  assert.equal(calls, 1)
})

test('history profile returns a positive decimal cursor without number conversion', async () => {
  const historyId = '90071992547409931234567890'
  let requestedUrl
  const result = await fetchGmailHistoryId(
    'token',
    options(async (url) => {
      requestedUrl = url
      return response(200, { historyId })
    })
  )

  assert.equal(result, historyId)
  assert.equal(
    requestedUrl,
    'https://gmail.googleapis.com/gmail/v1/users/me/profile?fields=historyId'
  )
})

test('history page requests messageAdded records and returns unique IDs with continuation', async () => {
  let requestedUrl
  const result = await fetchGmailHistoryPage(
    'token',
    '12345678901234567890',
    'page token',
    options(async (url) => {
      requestedUrl = url
      return response(200, {
        historyId: '12345678901234567891',
        nextPageToken: 'next page',
        history: [
          { messagesAdded: [{ message: { id: 'a' } }, { message: { id: 'b' } }] },
          { messagesAdded: [{ message: { id: 'a' } }] }
        ]
      })
    })
  )

  const parsed = new URL(requestedUrl)
  assert.equal(parsed.origin, 'https://gmail.googleapis.com')
  assert.equal(parsed.pathname, '/gmail/v1/users/me/history')
  assert.equal(parsed.searchParams.get('startHistoryId'), '12345678901234567890')
  assert.equal(parsed.searchParams.get('pageToken'), 'page token')
  assert.equal(parsed.searchParams.get('historyTypes'), 'messageAdded')
  assert.equal(parsed.searchParams.get('labelId'), 'INBOX')
  assert.equal(
    parsed.searchParams.get('fields'),
    'historyId,nextPageToken,history(messagesAdded(message(id)))'
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    historyId: '12345678901234567891',
    addedMessageIds: ['a', 'b'],
    nextPageToken: 'next page'
  })
})

test('absent added messages and next page return empty additions without a continuation', async () => {
  const result = await fetchGmailHistoryPage(
    'token',
    '8',
    undefined,
    options(async () => response(200, { historyId: '9', history: [{ id: 'ignored' }] }))
  )

  assert.deepEqual(JSON.parse(JSON.stringify(result)), { historyId: '9', addedMessageIds: [] })
})

test('blank or CR/LF credentials and invalid cursors reject before fetch', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    return response(200, {})
  }

  for (const token of ['', ' \t', 'token\rvalue', 'token\nvalue']) {
    await assert.rejects(fetchGmailHistoryId(token, options(fetch)))
  }
  for (const cursor of ['', '0', '01', '+1', '1.0', '1e2', ' 1', '1\n']) {
    await assert.rejects(fetchGmailHistoryPage('token', cursor, undefined, options(fetch)))
  }
  await assert.rejects(fetchGmailHistoryPage('token', 9, undefined, options(fetch)))
  for (const pageToken of [7, '', 'next\rpage', 'next\npage']) {
    await assert.rejects(fetchGmailHistoryPage('token', '9', pageToken, options(fetch)))
  }
  assert.equal(calls, 0)
})

test('profile malformed cursor and null payload fail closed', async () => {
  for (const body of [{ historyId: 9 }, { historyId: '0' }, null]) {
    await assert.rejects(
      fetchGmailHistoryId(
        'token',
        options(async () => response(200, body))
      ),
      (error) => error instanceof GmailMetadataFailure && error.code === 'invalid_response'
    )
  }
})

test('Gmail failure codes are sanitized for status, redirects, network errors, and malformed JSON', async () => {
  const cases = [
    [async () => response(401, { secret: 'body' }), 'unauthorized'],
    [async () => response(403, {}), 'forbidden'],
    [async () => response(429, {}), 'rate_limited'],
    [async () => response(503, {}), 'provider_error'],
    [async () => response(302, {}, { redirected: true }), 'redirect_refused'],
    [
      async () =>
        response(
          200,
          {},
          {
            json: async () => {
              throw new Error('secret body token')
            }
          }
        ),
      'invalid_response'
    ],
    [
      async () => {
        throw new Error('secret url token')
      },
      'network_error'
    ]
  ]

  for (const [fetch, code] of cases) {
    await assert.rejects(fetchGmailHistoryId('private-token', options(fetch)), (error) => {
      assert.equal(error instanceof GmailMetadataFailure, true)
      assert.equal(error.code, code)
      assert.equal(error.message.includes('private-token'), false)
      assert.equal(error.message.includes('secret'), false)
      return true
    })
  }
})

test('404 on unread count is provider_error rather than expired history', async () => {
  await assert.rejects(
    fetchGmailUnreadCount(
      'token',
      'INBOX',
      options(async () => response(404, {}))
    ),
    (error) => error instanceof GmailMetadataFailure && error.code === 'provider_error'
  )
})

test('404 on profile is provider_error rather than expired history', async () => {
  await assert.rejects(
    fetchGmailHistoryId(
      'token',
      options(async () => response(404, {}))
    ),
    (error) => error instanceof GmailMetadataFailure && error.code === 'provider_error'
  )
})

test('404 on a history page is history_expired', async () => {
  await assert.rejects(
    fetchGmailHistoryPage(
      'token',
      '4',
      undefined,
      options(async () => response(404, {}))
    ),
    (error) => error instanceof GmailMetadataFailure && error.code === 'history_expired'
  )
})

test('malformed optional history fields and page tokens fail closed', async () => {
  const malformed = [
    { historyId: '10', nextPageToken: 7 },
    { historyId: '10', nextPageToken: '' },
    { historyId: '10', nextPageToken: 'next\rpage' },
    { historyId: '10', nextPageToken: 'next\npage' },
    { historyId: '10', history: {} },
    { historyId: '10', history: [null] },
    { historyId: '10', history: [{ messagesAdded: {} }] },
    { historyId: '10', history: [{ messagesAdded: [{ message: { id: 4 } }] }] }
  ]
  for (const body of malformed) {
    await assert.rejects(
      fetchGmailHistoryPage(
        'token',
        '9',
        undefined,
        options(async () => response(200, body))
      ),
      (error) => error instanceof GmailMetadataFailure && error.code === 'invalid_response'
    )
  }
})

test('timeout wins while JSON parsing ignores AbortSignal', async () => {
  await assert.rejects(
    fetchGmailHistoryId(
      'token',
      options(async () => response(200, {}, { json: () => new Promise(() => {}) }), undefined, 5)
    ),
    (error) => error instanceof GmailMetadataFailure && error.code === 'timeout'
  )
})

test('external cancellation wins while JSON parsing ignores AbortSignal', async () => {
  const controller = new AbortController()
  let enteredJson
  const jsonStarted = new Promise((resolve) => {
    enteredJson = resolve
  })
  const pending = fetchGmailHistoryId(
    'token',
    options(
      async () =>
        response(
          200,
          {},
          {
            json: () => {
              enteredJson()
              return new Promise(() => {})
            }
          }
        ),
      controller.signal
    )
  )
  await jsonStarted
  controller.abort()

  await assert.rejects(
    pending,
    (error) => error instanceof GmailMetadataFailure && error.code === 'cancelled'
  )
})

test('timeout and cancellation settle when fetch ignores AbortSignal', async () => {
  await assert.rejects(
    fetchGmailHistoryId(
      'token',
      options(async () => new Promise(() => {}), undefined, 5)
    ),
    (error) => error instanceof GmailMetadataFailure && error.code === 'timeout'
  )
  const controller = new AbortController()
  const pending = fetchGmailHistoryId(
    'token',
    options(async () => new Promise(() => {}), controller.signal)
  )
  controller.abort()
  await assert.rejects(
    pending,
    (error) => error instanceof GmailMetadataFailure && error.code === 'cancelled'
  )
})

test('pre-aborted signal and invalid timeout reject before fetch', async () => {
  let calls = 0
  const controller = new AbortController()
  controller.abort()
  const fetch = async () => {
    calls += 1
    return response(200, { historyId: '1' })
  }

  await assert.rejects(
    fetchGmailHistoryId('token', options(fetch, controller.signal)),
    (error) => error instanceof GmailMetadataFailure && error.code === 'cancelled'
  )
  for (const timeoutMs of [0, -1, Infinity, NaN]) {
    await assert.rejects(
      fetchGmailHistoryId('token', options(fetch, new AbortController().signal, timeoutMs)),
      (error) => error instanceof GmailMetadataFailure && error.code === 'invalid_response'
    )
  }
  assert.equal(calls, 0)
})

test('message summary requests only From/Subject metadata and label ids', async () => {
  let requestedUrl
  const summary = await fetchGmailMessageSummary(
    'token-value',
    'msg_1-a',
    options(async (url) => {
      requestedUrl = url
      return response(200, {
        labelIds: ['UNREAD', 'INBOX'],
        payload: {
          headers: [
            { name: 'Subject', value: 'Hello' },
            { name: 'From', value: 'Ann <ann@example.com>' }
          ]
        }
      })
    })
  )
  const parsed = new URL(requestedUrl)
  assert.equal(parsed.pathname, '/gmail/v1/users/me/messages/msg_1-a')
  assert.equal(parsed.searchParams.get('format'), 'metadata')
  assert.deepEqual(parsed.searchParams.getAll('metadataHeaders'), ['From', 'Subject'])
  assert.equal(parsed.searchParams.get('fields'), 'labelIds,payload/headers')
  assert.deepEqual(
    { ...summary },
    { from: 'Ann <ann@example.com>', subject: 'Hello', unreadInInbox: true }
  )
})

test('message summary marks read or archived mail and rejects unsafe ids or headers', async () => {
  const read = await fetchGmailMessageSummary(
    'token-value',
    'm1',
    options(async () => response(200, { labelIds: ['INBOX'] }))
  )
  assert.deepEqual({ ...read }, { from: '', subject: '', unreadInInbox: false })
  let fetched = false
  await assert.rejects(
    fetchGmailMessageSummary(
      'token-value',
      '../stop',
      options(async () => {
        fetched = true
        return response(200, {})
      })
    ),
    { code: 'invalid_response' }
  )
  assert.equal(fetched, false)
  await assert.rejects(
    fetchGmailMessageSummary(
      'token-value',
      'm1',
      options(async () => response(200, { payload: { headers: [{ name: 'From', value: 1 }] } }))
    ),
    { code: 'invalid_response' }
  )
})
