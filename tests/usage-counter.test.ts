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
    // The speed figures are right-aligned in a shared column, so 145.8 and
    // 35.5 end in the same place (Jeff 2026-08-07). That costs one character,
    // which tips this row past the mobile ceiling into the tight column gaps.
    '-# ` input ↑  66,889    output ↓ 5,169  ◷ 145.8 s  `',
    '-# ` cache ↑ 958,376 reasoning ↓ 1,000  »  35.5 t/s`',
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
    '-# ` input ↑ 2,469,135    output ↓   19  ◷ 19.0 s  `',
    '-# ` cache ↑ 9,876,543                   »  1.0 t/s`',
  ].join('\n'))

  const rows = footer.split('\n').slice(2)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
  assert.doesNotMatch(rows[1], /reasoning/)
})

test('usage counter keeps eight-digit cache values exact when tightened rows fit', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 99_765_431,
    outputTokens: 19,
    cachedInputTokens: 98_765_432,
    reasoningTokens: 0,
  }, 19_000)

  const rows = footer.split('\n').slice(2)
  assert.match(rows[1], /cache ↑ 98,765,432/)
  assert.doesNotMatch(rows[1], /98\.8m/)
  assert.ok(rows[0].length <= 55)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
})

test('usage counter tightens column gaps before compacting readable values', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 2_883_507,
    outputTokens: 13_192,
    cachedInputTokens: 2_783_232,
    reasoningTokens: 5_978,
  }, 614_100)

  const rows = footer.split('\n').slice(2)
  assert.match(rows[0], /input ↑\s+100,275\s+output ↓ 13,192\s+◷ 614\.1 s/)
  // 21.5 is right-aligned under the wider 614.1, so it carries a leading pad.
  assert.match(rows[1], /cache ↑ 2,783,232\s+reasoning ↓\s+5,978\s+»\s+21\.5 t\/s/)
  assert.ok(rows[0].length <= 55)
  assert.equal(rows[0].length, rows[1].length)
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

test('usage counter keeps readable values exact while the mobile pill still fits', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 5_715_362,
    outputTokens: 16_642,
    cachedInputTokens: 5_582_336,
    reasoningTokens: 4_437,
  }, 723_800)

  const rows = footer.split('\n').slice(2)
  assert.match(rows[0], /input ↑   133,026/)
  assert.match(rows[0], /output ↓ 16,642/)
  assert.match(rows[1], /cache ↑ 5,582,336/)
  assert.match(rows[1], /reasoning ↓  4,437/)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
  assert.ok(rows[0].length <= 60)
})

test('usage counter drops speed decimals when compact numbers still exceed the mobile ceiling', () => {
  const footer = formatUsageCounter('both', {
    inputTokens: 999_999_999_999,
    outputTokens: 999_999_999,
    cachedInputTokens: 888_888_888_888,
    reasoningTokens: 888_888_888,
  }, 999_999_900)

  const rows = footer.split('\n').slice(2)
  assert.doesNotMatch(rows[0], /\d+\.\d s/)
  assert.doesNotMatch(rows[1], /\d+\.\d t\/s/)
  assert.equal(rows[0].length, rows[1].length)
  assert.equal(rows[0].indexOf('◷'), rows[1].indexOf('»'))
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
