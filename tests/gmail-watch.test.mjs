/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Node executes this test as JavaScript. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const { GmailMetadataFailure, registerGmailWatch, stopGmailWatch } = loadTypeScript(
  new URL('../src/main/gmail-metadata.ts', import.meta.url)
)

function options(
  fetch,
  now = () => 1_800_000_000_000,
  signal = new AbortController().signal,
  timeoutMs
) {
  return { fetch, now, signal, timeoutMs }
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

function assertCode(promise, code) {
  return assert.rejects(promise, (error) => {
    assert.equal(error instanceof GmailMetadataFailure, true)
    assert.equal(error.code, code)
    assert.equal(error.cause, undefined)
    assert.equal(error.message.includes('secret'), false)
    assert.equal(error.message.includes('private-token'), false)
    return true
  })
}

test('registers minimal watch request and preserves history cursor precision', async () => {
  let request
  const historyId = '90071992547409931234567890'
  const result = await registerGmailWatch(
    'private-token',
    'projects/project_1/topics/topic-1',
    options(async (url, init) => {
      request = { url, init }
      return response(200, { historyId, expiration: '1800000001000', extra: 'ignored' })
    })
  )
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { historyId, expiresAt: 1_800_000_001_000 })
  assert.equal(
    request.url,
    'https://gmail.googleapis.com/gmail/v1/users/me/watch?fields=historyId%2Cexpiration'
  )
  assert.equal(request.init.method, 'POST')
  assert.deepEqual(JSON.parse(JSON.stringify(request.init.headers)), {
    Authorization: 'Bearer private-token',
    'Content-Type': 'application/json'
  })
  assert.equal(
    request.init.body,
    JSON.stringify({ topicName: 'projects/project_1/topics/topic-1' })
  )
  assert.equal(request.url.includes('private-token'), false)
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.signal instanceof AbortSignal, true)
})

test('invalid topic names and initial clocks reject before fetch', async () => {
  let calls = 0
  const fetch = async () => {
    calls += 1
    return response(200, { historyId: '1', expiration: '1800000001000' })
  }
  for (const topic of [
    '',
    ' projects/p/topics/t',
    'projects/p/topics/',
    'projects/p/topics/t/x',
    'projects/p/topics/t?x=1',
    'projects/p/topics/t\r'
  ]) {
    await assertCode(registerGmailWatch('token', topic, options(fetch)), 'invalid_response')
  }
  for (const now of [
    () => -1,
    () => 1.2,
    () => Number.MAX_SAFE_INTEGER + 1,
    () => Infinity,
    () => {
      throw Error('secret')
    }
  ]) {
    await assertCode(
      registerGmailWatch('token', 'projects/p/topics/t', options(fetch, now)),
      'invalid_response'
    )
  }
  await assertCode(
    registerGmailWatch('token', 'projects/p/topics/t', {
      fetch,
      signal: new AbortController().signal,
      get now() {
        throw Error('secret clock getter')
      }
    }),
    'invalid_response'
  )
  assert.equal(calls, 0)
})

test('invalid watch history and expiration values fail closed', async () => {
  const now = 1_800_000_000_000
  for (const body of [
    { historyId: '0', expiration: '1800000001000' },
    { historyId: 9, expiration: '1800000001000' },
    { historyId: '1', expiration: '0' },
    { historyId: '1', expiration: '01800000001000' },
    { historyId: '1', expiration: '+1800000001000' },
    { historyId: '1', expiration: '1800000000000' },
    { historyId: '1', expiration: '1800000001000x' },
    { historyId: '1', expiration: '9007199254740992' },
    null
  ]) {
    await assertCode(
      registerGmailWatch(
        'token',
        'projects/p/topics/t',
        options(
          async () => response(200, body),
          () => now
        )
      ),
      'invalid_response'
    )
  }
})

test('lease is compared with a fresh clock reading after JSON is read', async () => {
  let clockCalls = 0
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(
        async () => response(200, { historyId: '1', expiration: '1800000001000' }),
        () => {
          clockCalls += 1
          return clockCalls === 1 ? 1_800_000_000_000 : 1_800_000_001_000
        }
      )
    ),
    'invalid_response'
  )
  assert.equal(clockCalls, 2)
})

test('a clock error after response is sanitized as invalid_response', async () => {
  let clockCalls = 0
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(
        async () => response(200, { historyId: '1', expiration: '1800000001000' }),
        () => {
          clockCalls += 1
          if (clockCalls === 2) throw Error('secret')
          return 1_800_000_000_000
        }
      )
    ),
    'invalid_response'
  )
  let calls = 0
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(
        async () => response(200, { historyId: '1', expiration: '1800000001000' }),
        () => {
          calls += 1
          return calls === 1 ? 1_800_000_000_000 : Number.NaN
        }
      )
    ),
    'invalid_response'
  )
})

test('stop posts without a body and accepts only an empty JSON object', async () => {
  let request
  await stopGmailWatch(
    'token',
    options(async (url, init) => {
      request = { url, init }
      return response(200, {})
    })
  )
  assert.equal(request.url, 'https://gmail.googleapis.com/gmail/v1/users/me/stop')
  assert.equal(request.init.method, 'POST')
  assert.equal(Object.hasOwn(request.init, 'body'), false)
  assert.deepEqual(JSON.parse(JSON.stringify(request.init.headers)), {
    Authorization: 'Bearer token'
  })
  await stopGmailWatch(
    'token',
    options(async () =>
      response(204, undefined, {
        json: () => assert.fail('204 must not parse a response body')
      })
    )
  )
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(
        async () => response(204, undefined),
        () => 1_800_000_000_000
      )
    ),
    'invalid_response'
  )
  for (const body of [null, [], { ok: true }, { extra: 1 }]) {
    await assertCode(
      stopGmailWatch(
        'token',
        options(async () => response(200, body))
      ),
      'invalid_response'
    )
  }
  await assertCode(
    stopGmailWatch(
      'token',
      options(async () => response(200, undefined))
    ),
    'invalid_response'
  )
})

test('watch and stop sanitize provider failures, redirects, and transport exceptions', async () => {
  for (const [fetch, code] of [
    [async () => response(401, {}), 'unauthorized'],
    [async () => response(403, {}), 'forbidden'],
    [async () => response(404, {}), 'provider_error'],
    [async () => response(429, {}), 'rate_limited'],
    [async () => response(503, {}), 'provider_error'],
    [async () => response(302, {}, { redirected: true }), 'redirect_refused'],
    [
      async () => {
        throw Error('secret transport')
      },
      'network_error'
    ]
  ]) {
    await assertCode(
      registerGmailWatch('private-token', 'projects/p/topics/t', options(fetch)),
      code
    )
    await assertCode(stopGmailWatch('private-token', options(fetch)), code)
  }
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(async () =>
        response(
          200,
          {},
          {
            json: async () => {
              throw Error('secret JSON')
            }
          }
        )
      )
    ),
    'invalid_response'
  )
})

test('POST fetch timeout and cancellation remain enforced if fetch ignores abort', async () => {
  const never = () => new Promise(() => {})
  await assertCode(
    registerGmailWatch(
      'token',
      'projects/p/topics/t',
      options(never, undefined, new AbortController().signal, 5)
    ),
    'timeout'
  )
  const controller = new AbortController()
  const pending = stopGmailWatch('token', options(never, undefined, controller.signal, 10_000))
  controller.abort()
  await assertCode(pending, 'cancelled')
})

test('pre-aborted POST signal rejects before fetch', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const fetch = async () => {
    calls += 1
    return response(200, {})
  }
  await assertCode(stopGmailWatch('token', { fetch, signal: controller.signal }), 'cancelled')
  assert.equal(calls, 0)
})

test('POST JSON body timeout and cancellation remain enforced if json ignores abort', async () => {
  const never = async () => response(200, undefined, { json: () => new Promise(() => {}) })
  await assertCode(
    stopGmailWatch('token', options(never, undefined, new AbortController().signal, 5)),
    'timeout'
  )
  const controller = new AbortController()
  let enteredJson
  const jsonStarted = new Promise((resolve) => {
    enteredJson = resolve
  })
  const pending = registerGmailWatch(
    'token',
    'projects/p/topics/t',
    options(
      async () =>
        response(200, undefined, {
          json: () => {
            enteredJson()
            return new Promise(() => {})
          }
        }),
      () => 1_800_000_000_000,
      controller.signal,
      10_000
    )
  )
  await jsonStarted
  controller.abort()
  await assertCode(pending, 'cancelled')
})
