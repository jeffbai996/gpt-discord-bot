import assert from 'node:assert/strict'
import test from 'node:test'

import { formatUsageCounter } from '../src/usage-counter.ts'

test('usage counter aligns telemetry in two equal-width inline-code pills', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 1_025_265,
    outputTokens: 5_169,
    cachedInputTokens: 958_376,
    reasoningTokens: 1_000,
  }, 145_800)

  assert.equal(footer, [
    '',
    '',
    '-# ` input ↑  66,889      output ↓ 5,169    ◷ 145.8 s `',
    '-# ` cache ↑ 958,376   reasoning ↓ 1,000    » 35.5 t/s`',
  ].join('\n'))

  const rows = footer.split('\n').slice(2)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
})

test('usage counter blanks zero reasoning while preserving aligned columns', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 12_345_678,
    outputTokens: 19,
    cachedInputTokens: 9_876_543,
    reasoningTokens: 0,
  }, 19_000)

  assert.equal(footer, [
    '',
    '',
    '-# ` input ↑ 2.47m      output ↓   19    ◷ 19.0 s  `',
    '-# ` cache ↑ 9.88m                       »  1.0 t/s`',
  ].join('\n'))

  const rows = footer.split('\n').slice(2)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
  assert.doesNotMatch(rows[1], /reasoning/)
})

test('usage counter blanks zero cache while preserving aligned columns', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 37_219,
    outputTokens: 335,
    cachedInputTokens: 0,
    reasoningTokens: 274,
  }, 25_200)

  assert.equal(footer, [
    '',
    '',
    '-# ` input ↑  37,219      output ↓  335    ◷ 25.2 s  `',
    '-# `                   reasoning ↓  274    » 13.3 t/s`',
  ].join('\n'))

  const rows = footer.split('\n').slice(2)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
  assert.doesNotMatch(rows[1], /cache/)
})

test('usage counter drops the second row when cache and reasoning are zero', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }, 12_340)

  assert.equal(footer, '\n\n-# ` input ↑     100      output ↓   20    ◷ 12.3 s `')
})

test('usage counter compacts large values before a mobile pill can wrap', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 5_715_362,
    outputTokens: 16_642,
    cachedInputTokens: 5_582_336,
    reasoningTokens: 4_437,
  }, 723_800)

  const rows = footer.split('\n').slice(2)
  assert.match(rows[0], /input ↑  133k/)
  assert.match(rows[0], /output ↓ 16\.6k/)
  assert.match(rows[1], /cache ↑ 5\.58m/)
  assert.match(rows[1], /reasoning ↓ 4\.44k/)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
  assert.ok(rows[0].length <= 60)
})

test('usage counter shows duration without a wall label', () => {
  const footer = formatUsageCounter('token', {
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }, 12_340)

  assert.match(footer, /◷ 12\.3 s/)
  assert.match(footer, /-# ` input ↑/)
  assert.doesNotMatch(footer, /```/)
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
