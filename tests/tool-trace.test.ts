import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TOOL_CALL_WIDTH,
  DEFAULT_TOOL_OUTPUT_WIDTH,
  formatResultTraceLine,
} from '../src/tool-trace.ts'

test('uses the reduced Discord trace widths', () => {
  assert.equal(DEFAULT_TOOL_CALL_WIDTH, 80)
  assert.equal(DEFAULT_TOOL_OUTPUT_WIDTH, 72)
})

test('puts the result line count at the right edge of the preview row', () => {
  const line = formatResultTraceLine('alpha', 12, 20)

  assert.equal(line, ' ⎿ alpha     [12 lines]')
  assert.equal(line.length, 23)
})

test('trims the preview instead of widening the result row', () => {
  const line = formatResultTraceLine('abcdefghijklmnopqrstuvwxyz', 12, 20)

  assert.equal(line, ' ⎿ abcdefgh… [12 lines]')
  assert.equal(line.length, 23)
})

test('moves single-line result markers right without adding a count', () => {
  const line = formatResultTraceLine('alpha', 1, 20)

  assert.equal(line, ' ⎿ alpha')
})
