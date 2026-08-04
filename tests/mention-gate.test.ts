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

  test('rejects an explicit foreign mention when Discord injects self from a reply', () => {
    assert.equal(isAddressedToAnotherUser('111', [
      { id: '111', bot: true },
      { id: '222', bot: false },
    ], '<@222>'), true)
  })

  test('allows an explicit self mention even when another user is also explicit', () => {
    assert.equal(isAddressedToAnotherUser('111', [
      { id: '111', bot: true },
      { id: '222', bot: false },
    ], '<@111> please compare with <@222>'), false)
  })

  test('allows an ordinary reply whose only self mention is synthetic', () => {
    assert.equal(isAddressedToAnotherUser('111', [
      { id: '111', bot: true },
    ], 'following up on this'), false)
  })

  test('allows a message with no user mentions', () => {
    assert.equal(isAddressedToAnotherUser('self', []), false)
  })
})
