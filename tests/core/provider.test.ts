import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Provider } from '../../src/core/provider.ts'

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
