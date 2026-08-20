import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from '../src/models.ts'

test('API engine and postmortem stay on an available model while Codex uses the subscription model', () => {
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.5')
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol')
  assert.notEqual(DEFAULT_OPENAI_MODEL, DEFAULT_CODEX_MODEL)
})

test('Codex model catalog includes the entitled Daybreak Blue subscription model', () => {
  assert.ok(OPENAI_MODELS.includes('gpt-daybreak-blue-latest' as any))
  assert.ok(!OPENAI_MODELS.includes('gpt-daybreak-red-latest' as any))
})
