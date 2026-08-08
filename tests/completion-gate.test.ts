import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isBareActionPromise } from '../src/completion-gate.ts'

test('completion gate catches action promises with no executed tools', () => {
  assert.equal(isBareActionPromise(
    'Yep. I\'m making the repair resumable and self-driving.',
    [],
  ), true)
  assert.equal(isBareActionPromise('I\'ll fix it now.', []), true)
})

test('completion gate accepts completed work and ordinary future analysis', () => {
  assert.equal(isBareActionPromise('I\'m making the repair resumable.', [{ name: 'edit' }]), false)
  assert.equal(isBareActionPromise('Fixed and deployed; 42 tests pass.', []), false)
  assert.equal(isBareActionPromise('I think the stock will rise.', []), false)
})
