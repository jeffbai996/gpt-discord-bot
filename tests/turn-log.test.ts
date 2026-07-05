import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTurnOutcome } from '../src/turn-log.ts'

// The codex path is silent today (stderr → /dev/null, no logging), which is why
// mid-turn deaths read as "for some reason". formatTurnOutcome produces one
// scannable line per turn so `journalctl -u gpt` shows what actually happened.

test('formatTurnOutcome: normal completion line is scannable', () => {
  const line = formatTurnOutcome({
    outcome: 'completed', durationMs: 4200, lines: 37, replyChars: 512, timedOut: false, stoppedByUser: false,
  })
  assert.match(line, /\[codex-turn\]/)
  assert.match(line, /completed/)
  assert.match(line, /4\.2s/)          // human-readable duration
  assert.match(line, /37 lines/)
  assert.match(line, /512 chars/)
})

test('formatTurnOutcome: a timeout is loudly labelled', () => {
  const line = formatTurnOutcome({
    outcome: 'timeout', durationMs: 600_000, lines: 900, replyChars: 0, timedOut: true, stoppedByUser: false,
  })
  assert.match(line, /timeout/i)
  assert.match(line, /600(\.0)?s/)
  assert.match(line, /0 chars/)        // empty reply is the tell for a mid-turn death
})

test('formatTurnOutcome: a user stop is distinguishable from a timeout', () => {
  const line = formatTurnOutcome({
    outcome: 'stopped', durationMs: 12_000, lines: 40, replyChars: 0, timedOut: false, stoppedByUser: true,
  })
  assert.match(line, /stopped/i)
  assert.doesNotMatch(line, /timeout/i)
})
