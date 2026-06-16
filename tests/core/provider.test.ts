import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Provider } from '../../src/core/provider.ts'
import { OpenAIProvider } from '../../src/openai.ts'

test('a minimal object can satisfy the Provider contract', () => {
  const p: Provider = {
    id: 'stub',
    defaultModel: 'm',
    capabilities: { voice: false, managedCache: false, nativeWebSearch: false },
    async respond() {
      return { react: null, reply: '', usage: null, finishReason: 'stop', durationMs: 0, modelUsed: 'm' }
    },
    async embed() { return [0, 0, 0] }
  }
  assert.equal(p.id, 'stub')
  assert.equal(p.capabilities.voice, false)
})

test('OpenAIProvider conforms to Provider with correct capabilities', () => {
  const p: Provider = new OpenAIProvider('sk-test', 'gpt-5.5')
  assert.equal(p.id, 'openai')
  assert.equal(p.defaultModel, 'gpt-5.5')
  assert.equal(p.capabilities.voice, false)
  assert.equal(p.capabilities.managedCache, false)
  assert.equal(p.capabilities.nativeWebSearch, false)
  assert.equal(typeof p.respond, 'function')
  assert.equal(typeof p.embed, 'function')
})
