import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsageCounter } from '../src/usage-counter.ts'

test('usage counter headlines uncached input without a label', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 1_025_265,
    outputTokens: 5_169,
    cachedInputTokens: 958_376,
    reasoningTokens: 1_000,
  }, 145_800)

  assert.match(footer, /↑ 66,889/)
  assert.doesNotMatch(footer, /fresh/)
  assert.match(footer, /cache ↑ 958,376/)
  assert.doesNotMatch(footer, /cached/)
  assert.doesNotMatch(footer, /↑ 1,025,265/)
})

test('usage counter shows duration without a wall label', () => {
  const footer = formatUsageCounter('token', {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }, 12_340)

  assert.match(footer, /◷ 12\.3s/)
  assert.doesNotMatch(footer, /wall/)
})

test('usage counter remains empty when disabled', () => {
  assert.equal(formatUsageCounter('off', {
    inputTokens: 1,
    outputTokens: 1,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }, 1), '')
})
