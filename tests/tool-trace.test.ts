import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TOOL_CALL_WIDTH,
  DEFAULT_TOOL_OUTPUT_WIDTH,
  formatUnifiedDiffTrace,
  formatResultTraceLine,
  displayWidth,
  truncateDisplayWidth,
  resolveTraceFailsafeMs,
} from '../src/tool-trace.ts'

test('matches the Claude trace fence and reserves its output prefix', () => {
  assert.equal(DEFAULT_TOOL_CALL_WIDTH, 79)
  assert.equal(DEFAULT_TOOL_OUTPUT_WIDTH, 76)
})

test('caps emoji and CJK by rendered columns without splitting graphemes', () => {
  const line = truncateDisplayWidth('a'.repeat(75) + '❌中文', 79)
  assert.equal(displayWidth(line), 78)
  assert.equal(line, 'a'.repeat(75) + '❌…')
})

test('formats diff line numbers in the same column for every marker', () => {
  const formatted = formatUnifiedDiffTrace(
    '@@ -152,2 +153,3 @@\n-old\n+new\n context\n+tail\n',
  )

  assert.deepEqual(formatted, {
    badge: '[+2, -1]',
    body: [
      '- 152 old',
      '+ 153 new',
      ' 154 context',
      '+ 155 tail',
    ],
  })
})

test('puts the result line count at the right edge of the preview row', () => {
  const line = formatResultTraceLine('alpha', 12, 20)

  assert.equal(line, '⎿ alpha     [12 lines]')
  assert.equal(line.length, 22)
})

test('trims the preview instead of widening the result row', () => {
  const line = formatResultTraceLine('abcdefghijklmnopqrstuvwxyz', 12, 20)

  assert.equal(line, '⎿ abcdefgh… [12 lines]')
  assert.equal(line.length, 22)
})

test('aligns result counts by rendered width for wide preview text', () => {
  const line = formatResultTraceLine('中文', 12, 20)

  assert.equal(line, '⎿ 中文      [12 lines]')
  assert.equal(displayWidth(line), 22)
})

test('moves single-line result markers right without adding a count', () => {
  const line = formatResultTraceLine('alpha', 1, 20)

  assert.equal(line, '⎿ alpha')
})

test('trace failsafe cannot expire before a live turn can finish', () => {
  assert.equal(resolveTraceFailsafeMs(undefined, 45 * 60_000), 50 * 60_000)
  assert.equal(resolveTraceFailsafeMs('180000', 45 * 60_000), 50 * 60_000)
})

test('trace failsafe honors a longer explicit cleanup window', () => {
  assert.equal(resolveTraceFailsafeMs('3600000', 45 * 60_000), 60 * 60_000)
})
