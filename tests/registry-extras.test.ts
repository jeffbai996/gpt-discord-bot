import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ToolRegistry } from '../src/tools/registry.ts'

// Gap coverage for ToolRegistry: the dispatch try/catch error branch, has(),
// and toOpenAITools registration-order preservation.

function makeTool(name: string, exec?: () => Promise<string>) {
  return {
    name,
    description: `desc for ${name}`,
    parameters: { type: 'object' as const, properties: {} },
    execute: exec ?? (async () => `ran ${name}`)
  }
}

test('ToolRegistry: dispatch wraps thrown errors with tool name', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('boom', async () => { throw new Error('kaboom') }))
  const out = await r.dispatch('boom', {}, {})
  assert.match(out, /Error in boom/)
  assert.match(out, /kaboom/)
})

test('ToolRegistry: dispatch handles non-Error throws', async () => {
  const r = new ToolRegistry()
  r.register(makeTool('weird', async () => { throw 'string failure' }))
  const out = await r.dispatch('weird', {}, {})
  assert.match(out, /Error in weird/)
  assert.match(out, /string failure/)
})

test('ToolRegistry: has() reflects registration', () => {
  const r = new ToolRegistry()
  assert.equal(r.has('x'), false)
  r.register(makeTool('x'))
  assert.equal(r.has('x'), true)
  assert.equal(r.has('y'), false)
})

test('ToolRegistry: toOpenAITools preserves registration order', () => {
  const r = new ToolRegistry()
  r.register(makeTool('first'))
  r.register(makeTool('second'))
  r.register(makeTool('third'))
  const names = r.toOpenAITools().map(t => t.function.name)
  assert.deepEqual(names, ['first', 'second', 'third'])
})

test('ToolRegistry: toOpenAITools passes through parameters and description', () => {
  const r = new ToolRegistry()
  r.register({
    name: 'p',
    description: 'pdesc',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    async execute() { return '' }
  })
  const wrapped = r.toOpenAITools()[0]
  assert.equal(wrapped.function.description, 'pdesc')
  assert.deepEqual(wrapped.function.parameters, {
    type: 'object', properties: { q: { type: 'string' } }, required: ['q']
  })
})

test('ToolRegistry: empty registry yields empty tools array and size 0', () => {
  const r = new ToolRegistry()
  assert.equal(r.size(), 0)
  assert.deepEqual(r.toOpenAITools(), [])
})

test('ToolRegistry: toRealtimeTools is flat shape, no strict, order preserved', () => {
  const r = new ToolRegistry()
  r.register(makeTool('alpha'))
  r.register(makeTool('beta'))
  const rt = r.toRealtimeTools()
  assert.deepEqual(rt.map(t => t.name), ['alpha', 'beta'])
  const t0 = rt[0] as Record<string, unknown>
  assert.equal(t0.type, 'function')
  assert.equal(t0.name, 'alpha')
  assert.equal(t0.description, 'desc for alpha')
  assert.deepEqual(t0.parameters, { type: 'object', properties: {} })
  // Realtime shape must NOT carry `strict` (that's the Responses shape).
  assert.ok(!('strict' in t0))
})

test('voice tool dispatch: argsJson round-trips through dispatch (incl. malformed)', async () => {
  // Mirrors the onToolCall closure in command.ts: JSON.parse(argsJson||'{}')
  // then registry.dispatch. Verifies a good payload and a malformed one (→ {}).
  const r = new ToolRegistry()
  let seen: Record<string, unknown> | null = null
  r.register({
    name: 'echo',
    description: 'echo',
    parameters: { type: 'object' as const, properties: {} },
    execute: async (args) => { seen = args; return `got ${JSON.stringify(args)}` },
  })
  const run = async (argsJson: string) => {
    let args: Record<string, unknown> = {}
    try { args = JSON.parse(argsJson || '{}') } catch { /* malformed → {} */ }
    return r.dispatch('echo', args, { channelId: 'c', userId: 'u' })
  }
  assert.equal(await run('{"q":"hi"}'), 'got {"q":"hi"}')
  assert.deepEqual(seen, { q: 'hi' })
  assert.equal(await run('not json'), 'got {}')   // malformed → empty args, no throw
  assert.deepEqual(seen, {})
})
