import assert from 'node:assert/strict'
import test from 'node:test'

import { fmtLimitLines } from '../src/commands.ts'

const futureReset = () => Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60

test('limits labels a primary weekly window from its duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 1, windowMinutes: 10_080, resetsAt: futureReset() },
    planType: 'prolite',
  })

  assert.equal(lines.length, 1)
  assert.match(lines[0], /^weekly:/)
  assert.doesNotMatch(lines[0], /5-hour/)
})

test('limits labels a five-hour window from its duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 20, windowMinutes: 300, resetsAt: futureReset() },
  })

  assert.match(lines[0], /^5-hour:/)
})

test('limits labels other windows from their actual duration', () => {
  const lines = fmtLimitLines({
    primary: { usedPercent: 20, windowMinutes: 1_440, resetsAt: futureReset() },
    secondary: { usedPercent: 30, windowMinutes: 120, resetsAt: futureReset() },
  })

  assert.match(lines[0], /^1-day:/)
  assert.match(lines[1], /^2-hour:/)
})
