import assert from 'node:assert/strict'
import test from 'node:test'

import { fmtClearAcknowledgement, fmtContextPressureLine, fmtLimitLines, gptCommand } from '../src/commands.ts'

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

test('stats formats the latest codex prompt pressure against its context window', () => {
  assert.equal(
    fmtContextPressureLine({ lastInputTokens: 208_035, modelContextWindow: 258_400 }),
    'context:  208k / 258k tok  (81%)',
  )
})

test('stats omits context pressure until codex has emitted a usable snapshot', () => {
  assert.equal(fmtContextPressureLine({ lastInputTokens: 0, modelContextWindow: 258_400 }), null)
  assert.equal(fmtContextPressureLine({ lastInputTokens: 1_000, modelContextWindow: 0 }), null)
})

test('clear acknowledgement identifies the reset channel', () => {
  const message = fmtClearAcknowledgement('123456789')

  assert.match(message, /<#123456789>/)
  assert.match(message, /cleared — next turn starts fresh\./)
})

test('/gpt plan is a one-shot read-only planning command', () => {
  const json = gptCommand.toJSON()
  const plan = json.options?.find((option: any) => option.name === 'plan')

  assert.ok(plan)
  assert.match(plan.description, /next message read-only/i)
})
