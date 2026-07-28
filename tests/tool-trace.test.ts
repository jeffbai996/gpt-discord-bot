import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TOOL_CALL_WIDTH,
  DEFAULT_TOOL_OUTPUT_WIDTH,
  formatResultTraceLine,
  displayWidth,
  truncateDisplayWidth,
  resolveTraceFailsafeMs,
} from '../src/tool-trace.ts'

test('keeps the full Discord tool-call row within 78 columns', () => {
  assert.equal(DEFAULT_TOOL_CALL_WIDTH, 78)
  assert.equal(DEFAULT_TOOL_OUTPUT_WIDTH, 74)
})

test('caps emoji and CJK by rendered columns without splitting graphemes', () => {
  const line = truncateDisplayWidth('a'.repeat(73) + '❌中文', 78)
  assert.equal(displayWidth(line), 78)
  assert.equal(line, 'a'.repeat(73) + '❌中…')
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

test('trace failsafe cannot expire before a live turn can finish', () => {
  assert.equal(resolveTraceFailsafeMs(undefined, 45 * 60_000), 50 * 60_000)
  assert.equal(resolveTraceFailsafeMs('180000', 45 * 60_000), 50 * 60_000)
})

test('trace failsafe honors a longer explicit cleanup window', () => {
  assert.equal(resolveTraceFailsafeMs('3600000', 45 * 60_000), 60 * 60_000)
})
