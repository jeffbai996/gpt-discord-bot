import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GeminiProvider } from '../../../src/providers/gemini/gemini-provider.ts'
import type { Provider, LifecycleEvent } from '../../../src/core/provider.ts'
import { ToolRegistry } from '../../../src/tools/registry.ts'

// ---- Helpers ----

// Build a minimal GeminiProvider with a stubbed GoogleGenAI client.
// Patches the private `client` field to avoid real network calls.
function makeProvider(streamChunks: any[]): GeminiProvider {
  const p = new GeminiProvider('fake-key', 'gemini-3-flash-preview')
  // Stub the GoogleGenAI client's models.generateContentStream
  ;(p as any).client = {
    models: {
      generateContentStream: async (_params: any) => makeAsyncIterable(streamChunks)
    }
  }
  return p
}

// Create an AsyncIterable from an array of values.
function makeAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        async next() {
          if (i < items.length) {
            return { value: items[i++], done: false }
          }
          return { value: undefined as any, done: true }
        }
      }
    }
  }
}

// Build a stream chunk that carries a text part (simulates the model replying).
function textChunk(text: string, finishReason?: string): any {
  const candidate: any = {
    content: { parts: [{ text }], role: 'model' },
  }
  if (finishReason) candidate.finishReason = finishReason
  return { candidates: [candidate] }
}

// Build a stream chunk that carries a functionCall part.
function functionCallChunk(name: string, args: Record<string, unknown>): any {
  return {
    candidates: [{
      content: {
        parts: [{ functionCall: { name, args } }],
        role: 'model'
      },
      finishReason: 'STOP'
    }]
  }
}

// Build a usage chunk (last chunk with usageMetadata).
function usageChunk(prompt: number, candidates: number): any {
  return {
    candidates: [],
    usageMetadata: {
      promptTokenCount: prompt,
      candidatesTokenCount: candidates,
      totalTokenCount: prompt + candidates,
    }
  }
}

// ---- Tests ----

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

test('GeminiProvider.respond: plain text reply returns RespondResult', async () => {
  const reply = '{"react":null,"reply":"hello from gemini"}'
  const p = makeProvider([
    textChunk(reply, 'STOP'),
    usageChunk(100, 20),
  ])

  const result = await p.respond({
    systemPrompt: 'you are a bot',
    history: [],
    userMessage: 'hi',
    userName: 'alice',
    model: 'gemini-3-flash-preview',
  })

  assert.equal(result.reply, 'hello from gemini')
  assert.equal(result.react, null)
  assert.equal(result.modelUsed, 'gemini-3-flash-preview')
  assert.ok(result.durationMs >= 0)
})

test('GeminiProvider.respond: emits first_token and done lifecycle events', async () => {
  const reply = '{"react":null,"reply":"hello"}'
  const p = makeProvider([textChunk(reply, 'STOP')])

  const events: LifecycleEvent[] = []
  await p.respond({
    systemPrompt: 'you are a bot',
    history: [],
    userMessage: 'hi',
    userName: 'alice',
    model: 'gemini-3-flash-preview',
    onEvent: (e) => events.push(e),
  })

  const types = events.map(e => e.type)
  assert.ok(types.includes('first_token'), `expected first_token in ${JSON.stringify(types)}`)
  assert.ok(types.includes('done'), `expected done in ${JSON.stringify(types)}`)
})

test('GeminiProvider.respond: function-call loop dispatches tool + produces final reply', async () => {
  // First stream: model calls a tool
  // Second stream: model produces final text after the tool result
  let callCount = 0
  const finalReply = '{"react":"✅","reply":"the tool answered"}'

  const p = new GeminiProvider('fake-key', 'gemini-3-flash-preview')
  ;(p as any).client = {
    models: {
      generateContentStream: async (_params: any) => {
        callCount++
        if (callCount === 1) {
          // First turn: emit a functionCall
          return makeAsyncIterable([functionCallChunk('my_tool', { input: 'test' })])
        } else {
          // Second turn: emit the final answer
          return makeAsyncIterable([textChunk(finalReply, 'STOP')])
        }
      }
    }
  }

  // Set up a registry with a tool that records its call
  const registry = new ToolRegistry()
  let toolCalled = false
  let toolArgs: Record<string, unknown> = {}
  registry.register({
    name: 'my_tool',
    description: 'a test tool',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    async execute(args) {
      toolCalled = true
      toolArgs = args
      return 'tool result: success'
    }
  })

  const events: LifecycleEvent[] = []
  const result = await p.respond({
    systemPrompt: 'you are a bot',
    history: [],
    userMessage: 'use the tool',
    userName: 'alice',
    model: 'gemini-3-flash-preview',
    toolRegistry: registry,
    onEvent: (e) => events.push(e),
  })

  // Tool should have been called
  assert.ok(toolCalled, 'tool should have been dispatched')
  assert.deepEqual(toolArgs, { input: 'test' })

  // Final reply should be the second turn's text
  assert.equal(result.reply, 'the tool answered')
  assert.equal(result.react, '✅')

  // Lifecycle events should include tool_start and tool_end
  const types = events.map(e => e.type)
  assert.ok(types.includes('tool_start'), `expected tool_start in ${JSON.stringify(types)}`)
  assert.ok(types.includes('tool_end'), `expected tool_end in ${JSON.stringify(types)}`)
  assert.ok(types.includes('done'), `expected done in ${JSON.stringify(types)}`)

  // The generate stream should have been called twice (once for tool call, once for answer)
  assert.equal(callCount, 2)
})

test('GeminiProvider.respond: usage is populated from usageMetadata', async () => {
  const reply = '{"react":null,"reply":"done"}'
  const p = makeProvider([
    textChunk(reply, 'STOP'),
    usageChunk(200, 50),
  ])

  const result = await p.respond({
    systemPrompt: 'you are a bot',
    history: [],
    userMessage: 'test',
    userName: 'u',
    model: 'gemini-3-flash-preview',
  })

  assert.ok(result.usage !== null)
  assert.equal(result.usage!.inputTokens, 200)
  assert.equal(result.usage!.outputTokens, 50)
  assert.equal(result.usage!.totalTokens, 250)
})
