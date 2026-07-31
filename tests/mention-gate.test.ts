import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isAddressedToAnotherUser } from '../src/mention-gate.ts'

describe('isAddressedToAnotherUser', () => {
  test('rejects a message exclusively mentioning another bot', () => {
    assert.equal(isAddressedToAnotherUser('self', [{ id: 'other', bot: true }]), true)
  })

  test('rejects a message exclusively mentioning another human', () => {
    assert.equal(isAddressedToAnotherUser('self', [{ id: 'human', bot: false }]), true)
  })

  test('allows a message mentioning this bot', () => {
    assert.equal(isAddressedToAnotherUser('self', [{ id: 'self', bot: true }]), false)
  })

  test('allows a message mentioning this bot and another user', () => {
    assert.equal(isAddressedToAnotherUser('self', [
      { id: 'self', bot: true },
      { id: 'human', bot: false },
    ]), false)
  })

  test('allows a message with no user mentions', () => {
    assert.equal(isAddressedToAnotherUser('self', []), false)
  })
})
