import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENAI_MODEL, OPENAI_MODELS } from '../src/models.ts'

test('API engine and postmortem stay on an available model', () => {
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.6-sol')
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol')
})

test('Codex model catalog includes Astra and entitled Daybreak Blue without retired GPT-5.5', () => {
  assert.ok(OPENAI_MODELS.includes('gpt-6-astra' as any))
  assert.ok(OPENAI_MODELS.includes('gpt-daybreak-blue-latest' as any))
  assert.ok(!OPENAI_MODELS.includes('gpt-5.5' as any))
  assert.ok(!OPENAI_MODELS.includes('gpt-daybreak-red-latest' as any))
})
