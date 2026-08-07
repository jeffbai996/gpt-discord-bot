import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsageCounter } from '../src/usage-counter.ts'

/** Strip the Discord subtext/backtick wrapper off each rendered row. */
function rows(footer: string): string[] {
  return footer
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('-# '))
    .map((line) => line.replace(/^-# `/, '').replace(/`$/, ''))
}

// The duration and the throughput sit one above the other in two stacked
// pills. Only the throughput used to be padded, so the duration started a
// column to its left and the two numbers were visibly out of line
// (Jeff 2026-08-07: "8.2 and 2.3 should be lined up").
test('speed markers and digits share one column across both rows', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 12_000,
    outputTokens: 19,
    cachedInputTokens: 9_000,
    reasoningTokens: 256,
  }, 8_200)

  const [top, bottom] = rows(footer)
  const clock = top.indexOf('◷')
  const arrow = bottom.indexOf('»')
  assert.ok(clock > 0 && arrow > 0, 'both speed markers render')
  assert.equal(clock, arrow, 'markers start in the same column')
  // The figures are right-aligned in a shared column, so it is the END of each
  // number that must line up, not the first digit.
  assert.equal(top.indexOf(' s', clock), bottom.indexOf(' t/s', arrow),
    'both figures end in the same column')
})

test('alignment holds when the duration is wider than the throughput', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 12_000,
    outputTokens: 40,
    cachedInputTokens: 9_000,
    reasoningTokens: 256,
  }, 1_234_500)   // 1234.5 s — wider than any plausible t/s figure

  const [top, bottom] = rows(footer)
  const clock = top.indexOf('◷')
  const arrow = bottom.indexOf('»')
  assert.equal(clock, arrow)
  assert.equal(top.indexOf(' s', clock), bottom.indexOf(' t/s', arrow))
})
