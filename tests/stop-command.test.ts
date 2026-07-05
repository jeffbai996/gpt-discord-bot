import test from 'node:test'
import assert from 'node:assert/strict'
import { isHardStopMessage } from '../src/stop-command.ts'

test('isHardStopMessage: accepts lone X variants and ❌', () => {
  assert.equal(isHardStopMessage('X'), true)
  assert.equal(isHardStopMessage('x'), true)
  assert.equal(isHardStopMessage('  X  '), true)
  assert.equal(isHardStopMessage('❌'), true)
  assert.equal(isHardStopMessage('❌️'), true)
})

test('isHardStopMessage: rejects normal text containing x', () => {
  assert.equal(isHardStopMessage('x please stop'), false)
  assert.equal(isHardStopMessage('fix'), false)
  assert.equal(isHardStopMessage(''), false)
})
