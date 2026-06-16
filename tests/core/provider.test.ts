import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Provider, CoreMessage, RespondInput } from '../../src/core/provider.ts'
import { OpenAIProvider } from '../../src/openai.ts'
import { FakeProvider } from '../../src/providers/fake-provider.ts'

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

test('RespondInput.history accepts neutral CoreMessage[], not OpenAI params', () => {
  // HistoryMessage shape (src/history.ts): { id, authorId, authorName, content, attachments }.
  // There is NO `role` field — the provider derives role from authorId === selfId.
  const history: CoreMessage[] = [
    { id: '1', authorId: 'u1', authorName: 'alice', content: 'hi', attachments: [] }
  ]
  const input: RespondInput = {
    systemPrompt: '', history, userMessage: 'yo', userName: 'alice', model: 'm'
  }
  assert.equal(input.history[0].content, 'hi')
})

test('FakeProvider returns a scripted reply + deterministic embedding', async () => {
  const p = new FakeProvider({ reply: 'hello' })
  const res = await p.respond({
    systemPrompt: '', history: [], userMessage: 'hi', userName: 'u', model: 'fake'
  })
  assert.equal(res.reply, 'hello')
  assert.equal(res.modelUsed, 'fake')
  const e1 = await p.embed('x')
  const e2 = await p.embed('x')
  assert.deepEqual(e1, e2)               // deterministic
  assert.equal(e1.length, 1536)
})
