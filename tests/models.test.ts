import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENAI_MODEL } from '../src/models.ts'

test('API fallback stays on an available model while Codex uses the subscription model', () => {
  assert.equal(DEFAULT_OPENAI_MODEL, 'gpt-5.5')
  assert.equal(DEFAULT_CODEX_MODEL, 'gpt-5.6-sol')
  assert.notEqual(DEFAULT_OPENAI_MODEL, DEFAULT_CODEX_MODEL)
})
