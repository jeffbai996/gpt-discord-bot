import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { isAddressedToAnotherBot } from '../src/mention-gate.ts'

describe('isAddressedToAnotherBot', () => {
  test('rejects a message exclusively mentioning another bot', () => {
    assert.equal(isAddressedToAnotherBot('self', [{ id: 'other', bot: true }]), true)
  })

  test('allows a message mentioning this bot', () => {
    assert.equal(isAddressedToAnotherBot('self', [{ id: 'self', bot: true }]), false)
  })

  test('allows a message mentioning this bot and another bot', () => {
    assert.equal(isAddressedToAnotherBot('self', [
      { id: 'self', bot: true },
      { id: 'other', bot: true },
    ]), false)
  })

  test('does not treat a human-only mention as bot addressing', () => {
    assert.equal(isAddressedToAnotherBot('self', [{ id: 'human', bot: false }]), false)
  })
})
