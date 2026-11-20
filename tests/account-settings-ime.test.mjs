import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTypeScript } from './helpers/load-typescript.mjs'

const nameSaveCalls = []
const cancellationRefs = []
const { AccountSettings } = loadTypeScript(
  new URL(
    '../src/renderer/src/components/settings/AccountSettings/AccountSettings.tsx',
    import.meta.url
  ),
  {
    '../SettingsDialog/SettingsDialog': { SettingsRow: () => null },
    window: {
      api: {
        setAccountDisplayName(accountId, displayName) {
          nameSaveCalls.push({ accountId, displayName })
          return Promise.resolve({})
        }
      }
    }
  }
)

/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JavaScript test helper. */
function nameInputProps() {
  const nameEditCancelledRef = { current: false }
  cancellationRefs.push(nameEditCancelledRef)
  const component = AccountSettings({
    accounts: {
      version: 1,
      activeAccountId: 'account-1',
      accounts: [{ id: 'account-1', email: 'person@example.com', displayName: null, color: 'blue' }]
    },
    text: {
      accountName: 'Account name',
      accountNamePlaceholder: 'Name',
      accountColors: {
        blue: 'Blue',
        purple: 'Purple',
        green: 'Green',
        orange: 'Orange',
        gray: 'Gray'
      }
    },
    accountActionsBusy: false,
    accountNameDrafts: { 'account-1': '한글' },
    setAccountNameDrafts() {
      return undefined
    },
    accountSettingsBusy: null,
    setAccountSettingsBusy() {
      return undefined
    },
    accountSettingsFailed: false,
    setAccountSettingsFailed() {
      return undefined
    },
    accountNameSaveFailed: false,
    setAccountNameSaveFailed() {
      return undefined
    },
    editingAccountId: 'account-1',
    setEditingAccountId() {
      return undefined
    },
    nameEditCancelledRef,
    accountLimitReached: false,
    onAdd() {
      return undefined
    },
    onRemove() {
      return undefined
    },
    onAccountsChange() {
      return undefined
    }
  })
  const pending = [component]
  // Traverse the React element tree returned by the actual TSX component.
  while (pending.length) {
    const element = pending.pop()
    if (!element || typeof element !== 'object') continue
    if (Array.isArray(element)) {
      pending.push(...element)
      continue
    }
    if (typeof element.props?.onKeyDown === 'function') return element.props
    const children = element.props?.children
    if (Array.isArray(children)) pending.push(...children)
    else pending.push(children)
  }
  throw new Error('Account name input handler was not rendered')
}

test('IME Enter and Escape including keyCode 229 do not blur the real name input', () => {
  const props = nameInputProps()
  for (const key of ['Enter', 'Escape']) {
    for (const eventState of [
      { isComposing: true, keyCode: 13 },
      { isComposing: false, keyCode: 229 }
    ]) {
      let blurred = false
      props.onKeyDown({
        key,
        ...eventState,
        nativeEvent: { isComposing: eventState.isComposing },
        preventDefault() {
          return undefined
        },
        currentTarget: {
          blur() {
            blurred = true
          }
        }
      })
      assert.equal(blurred, false, `${key} during composition should not blur`)
    }
  }
})

test('ordinary Enter saves on blur and ordinary Escape cancels on blur', () => {
  const props = nameInputProps()
  nameSaveCalls.length = 0
  const cancellationRef = cancellationRefs.at(-1)
  for (const key of ['Enter', 'Escape']) {
    let blurred = false
    props.onKeyDown({
      key,
      keyCode: key === 'Enter' ? 13 : 27,
      nativeEvent: { isComposing: false },
      preventDefault() {
        return undefined
      },
      currentTarget: {
        blur() {
          blurred = true
        }
      }
    })
    assert.equal(blurred, true, `${key} outside composition should blur`)
    props.onBlur()
    assert.equal(cancellationRef.current, false)
  }
  assert.deepEqual(nameSaveCalls, [{ accountId: 'account-1', displayName: '한글' }])
})
