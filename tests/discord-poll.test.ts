import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPoll, parsePollAnswers } from '../src/discord-poll.ts'

test('parses numbered text and emoji-labelled poll options', () => {
  assert.deepEqual(parsePollAnswers('🍣 Sushi | 🌮 Tacos | Pizza'), [
    { text: 'Sushi', emoji: '🍣' }, { text: 'Tacos', emoji: '🌮' }, { text: 'Pizza' },
  ])
})

test('builds a native Discord poll and validates bounds', () => {
  assert.deepEqual(buildPoll('Dinner?', 'Sushi | Tacos', 6, true), {
    question: { text: 'Dinner?' }, answers: [{ text: 'Sushi' }, { text: 'Tacos' }], duration: 6, allowMultiselect: true,
  })
  assert.throws(() => buildPoll('x', 'only one'), /2–10/)
})
