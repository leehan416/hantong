import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'

test('account sessions are requested lazily using separate stable persistent partitions', () => {
  const requested = []
  const { getAccountSession } = loadTypeScript(
    new URL('../src/main/account-session.ts', import.meta.url),
    {
      electron: {
        session: {
          fromPartition: (partition) => {
            requested.push(partition)
            return partition
          }
        }
      }
    }
  )
  assert.deepEqual(requested, [])
  assert.equal(getAccountSession(firstId), `persist:hantong-gmail-${firstId}`)
  assert.equal(getAccountSession(secondId), `persist:hantong-gmail-${secondId}`)
  assert.equal(getAccountSession(firstId), `persist:hantong-gmail-${firstId}`)
  assert.throws(() => getAccountSession('../hantong-ui'), /Invalid account data/)
  assert.equal(requested.length, 3)
})
