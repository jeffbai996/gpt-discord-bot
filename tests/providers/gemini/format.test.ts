import { test } from 'node:test'
import assert from 'node:assert/strict'
import { coreMessagesToContents, registryToGeminiTools } from '../../../src/providers/gemini/format.ts'
import { ToolRegistry } from '../../../src/tools/registry.ts'

test('coreMessagesToContents maps CoreMessage to Gemini Content with role + text', () => {
  const out = coreMessagesToContents(
    [{ id: '1', authorId: 'bot1', authorName: 'gem', content: 'hello', attachments: [] }],
    'bot1'  // selfId → this message is the model's own
  )
  assert.equal(out[0].role, 'model')
  assert.ok(out[0].parts.some((p: any) => p.text?.includes('hello')))
})

test('coreMessagesToContents prefixes user name for non-self messages', () => {
  const out = coreMessagesToContents(
    [{ id: '2', authorId: 'u1', authorName: 'alice', content: 'hi there', attachments: [] }],
    'bot1'
  )
  assert.equal(out[0].role, 'user')
  const textPart = out[0].parts.find((p: any) => typeof p.text === 'string')
  assert.ok((textPart as any).text.includes('alice'))
  assert.ok((textPart as any).text.includes('hi there'))
})

test('coreMessagesToContents handles mixed bot and user messages', () => {
  const msgs = [
    { id: '1', authorId: 'u1', authorName: 'alice', content: 'question', attachments: [] },
    { id: '2', authorId: 'bot1', authorName: 'bot', content: 'answer', attachments: [] },
    { id: '3', authorId: 'u1', authorName: 'alice', content: 'follow-up', attachments: [] },
  ]
  const out = coreMessagesToContents(msgs, 'bot1')
  assert.equal(out[0].role, 'user')
  assert.equal(out[1].role, 'model')
  assert.equal(out[2].role, 'user')
})

test('coreMessagesToContents adds image parts for CoreImagePart with url', () => {
  const msgs = [
    {
      id: '1',
      authorId: 'u1',
      authorName: 'alice',
      content: 'check this',
      attachments: [],
      imageParts: [{ mimeType: 'image/png', url: 'https://example.com/img.png' }]
    }
  ]
  // imageParts are threaded through as extra field for future use;
  // currently format.ts ignores them (they come in via the current user message, not history)
  // This test just verifies it doesn't crash.
  const out = coreMessagesToContents(msgs as any, 'bot1')
  assert.equal(out.length, 1)
})

test('registryToGeminiTools returns a tools array shaped for the SDK', () => {
  const r = new ToolRegistry()
  r.register({ name: 't', description: 'd', parameters: { type: 'object', properties: {} }, async execute() { return 'ok' } })
  const tools = registryToGeminiTools(r)
  assert.ok(Array.isArray(tools))
})

test('registryToGeminiTools includes functionDeclarations with correct name', () => {
  const r = new ToolRegistry()
  r.register({
    name: 'my_tool',
    description: 'does something',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'the query' } }, required: ['query'] },
    async execute() { return 'ok' }
  })
  const tools = registryToGeminiTools(r)
  // Should have a functionDeclarations entry
  const fnDecls = tools.find((t: any) => t.functionDeclarations)
  assert.ok(fnDecls, 'should have functionDeclarations')
  assert.ok(fnDecls.functionDeclarations.some((d: any) => d.name === 'my_tool'))
})

test('registryToGeminiTools includes googleSearch when enabled', () => {
  const r = new ToolRegistry()
  const tools = registryToGeminiTools(r, { googleSearch: true })
  const hasSearch = tools.some((t: any) => t.googleSearch !== undefined)
  assert.ok(hasSearch, 'googleSearch tool should be present when enabled')
})

test('registryToGeminiTools omits googleSearch when not enabled', () => {
  const r = new ToolRegistry()
  const tools = registryToGeminiTools(r)
  const hasSearch = tools.some((t: any) => t.googleSearch !== undefined)
  assert.ok(!hasSearch, 'googleSearch should not be present by default')
})
