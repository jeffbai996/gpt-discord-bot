import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiProvider } from '../../../src/providers/gemini/gemini-provider.ts'
import type { Provider } from '../../../src/core/provider.ts'

test('GeminiProvider conforms to Provider with Gemini capabilities', () => {
  const p: Provider = new GeminiProvider('key', 'gemini-3-flash-preview')
  assert.equal(p.id, 'gemini')
  assert.equal(p.defaultModel, 'gemini-3-flash-preview')
  assert.equal(p.capabilities.voice, true)
  assert.equal(p.capabilities.managedCache, true)
  assert.equal(p.capabilities.nativeWebSearch, true)
})

test('GeminiProvider has correct method signatures', () => {
  const p = new GeminiProvider('key', 'gemini-3-flash-preview')
  assert.equal(typeof p.respond, 'function')
  assert.equal(typeof p.embed, 'function')
})
