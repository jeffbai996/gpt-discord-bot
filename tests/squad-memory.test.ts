import { describe, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { makeSquadMemoryTool } from '../src/tools/squad-memory.ts'

// The tool talks to the shared-memory HTTP API. Stub globalThis.fetch and assert
// (a) which URL each mode hits and (b) that the response is parsed/rendered.
const realFetch = globalThis.fetch
let lastUrl = ''

function stubFetch(handler: (url: string) => { status?: number; json: any }) {
  globalThis.fetch = (async (input: any) => {
    lastUrl = String(input)
    const { status = 200, json } = handler(lastUrl)
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json
    } as any
  }) as any
}

const tool = makeSquadMemoryTool()

beforeEach(() => { lastUrl = '' })
afterEach(() => { globalThis.fetch = realFetch })

describe('search_squad_memory declaration', () => {
  test('exposes id, recent, query; none required', () => {
    const p = tool.parameters as any
    assert.deepEqual(p.required, [])
    assert.ok(p.properties.id)
    assert.ok(p.properties.recent)
    assert.ok(p.properties.query)
  })
})

describe('search (query) mode', () => {
  test('hits /api/search?mode=hybrid and renders the body', async () => {
    stubFetch(() => ({
      json: { ok: true, q: 'paul', mode: 'hybrid', count: 1, total: 1,
        entries: [{ id: 7, type: 'project', name: 'thing', text: 'body text here', tags: [], about: [], pinned: false, ts: '' }] }
    }))
    const out = await tool.execute({ query: 'who is paul' }, {} as any)
    assert.match(lastUrl, /\/api\/search\?q=who/)
    assert.match(lastUrl, /mode=hybrid/)
    assert.match(out, /#7/)
    assert.match(out, /body text here/)
  })

  test('no arg returns guidance naming all three modes', async () => {
    const out = await tool.execute({}, {} as any)
    assert.match(out, /id/i)
    assert.match(out, /recent/i)
    assert.match(out, /query/i)
  })

  test('long bodies are NOT chopped to 600 chars (truncation fix)', async () => {
    const big = 'x'.repeat(5000)
    stubFetch(() => ({
      json: { ok: true, q: 'p', mode: 'hybrid', count: 1, total: 1,
        entries: [{ id: 1, type: 'project', name: 'big', text: big, tags: [], about: [], pinned: false, ts: '' }] }
    }))
    const out = await tool.execute({ query: 'p' }, {} as any)
    // 5000-char body must survive (old cap was 600).
    assert.ok(out.includes('x'.repeat(5000)), 'body should not be truncated at 600')
  })
})

describe('recent mode', () => {
  test('recent:true hits /api/recall?recent=1 and renders newest-first', async () => {
    stubFetch(() => ({
      json: { ok: true, source: 'recent', count: 2, entries: [
        { id: 198, type: 'project', name: 'newest', text: 'latest', tags: [], about: [], pinned: false, ts: '' },
        { id: 197, type: 'project', name: 'older', text: 'prior', tags: [], about: [], pinned: false, ts: '' }
      ] }
    }))
    const out = await tool.execute({ recent: true, query: 'ignored' }, {} as any)
    assert.match(lastUrl, /\/api\/recall\?recent=1/)
    assert.match(out, /newest memories first/)
    assert.match(out, /#198/)
    assert.match(out, /#197/)
  })
})

describe('by-id mode', () => {
  test('numeric id hits /api/memory/<id> (not /api/files or search)', async () => {
    stubFetch(() => ({
      json: { memory: { id: 84, type: 'user', name: 'profile', text: 'the answer', tags: [], about: [], pinned: false, ts: '' } }
    }))
    const out = await tool.execute({ id: 84 }, {} as any)
    assert.match(lastUrl, /\/api\/memory\/84/)
    assert.doesNotMatch(lastUrl, /\/api\/files|\/api\/search|\/api\/recall/)
    assert.match(out, /#84/)
    assert.match(out, /the answer/)
  })

  test('id takes precedence over recent and query', async () => {
    stubFetch(() => ({ json: { memory: { id: 5, type: 'project', name: 'x', text: 'y', tags: [], about: [], pinned: false, ts: '' } } }))
    await tool.execute({ id: 5, recent: true, query: 'q' }, {} as any)
    assert.match(lastUrl, /\/api\/memory\/5/)
  })

  test('404 returns a clean not-found string', async () => {
    stubFetch(() => ({ status: 404, json: {} }))
    const out = await tool.execute({ id: 999999 }, {} as any)
    assert.match(out, /No squad memory has id #999999/)
  })
})
