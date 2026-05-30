import type { Tool } from './registry.ts'

// Shape returned by shared-memory GET /api/search, verified live against the
// local Flask bind at http://127.0.0.1:5005:
//   { ok, q, mode, count, total, entries: SquadEntry[], ... }
// `count` = number of entries in this returned slice; `total` = full match count.
interface SquadEntry {
  id: number
  type: string // "project" | "user" | "feedback" | "reference"
  name: string // short title
  text: string // the actual memory body
  tags: string[]
  about: string[]
  pinned: boolean
  ts: string
}

interface SquadSearchResponse {
  ok: boolean
  q: string
  mode: string
  count: number
  total: number
  entries: SquadEntry[]
}

// Cap how many entries we surface and how much body text each one contributes,
// so a broad query cannot flood the model context window.
const MAX_ENTRIES = 8
const MAX_TEXT_CHARS = 600
const FETCH_TIMEOUT_MS = 8000

// Read-only tool: searches the shared shared-memory memory over HTTP. Unlike
// makeSearchMemoryTool it needs no OpenAI client or local store — just native
// fetch + an env-overridable base URL — so the factory takes no args.
export function makeSquadMemoryTool(): Tool {
  return {
    name: 'search_squad_memory',
    description:
      'Search the shared shared-memory memory (durable facts about the user, their projects, portfolio, and the bot squad) for relevant context. Read-only. Use when you need background the current conversation does not provide. Returns matching memories with id, name, type, tags, and text.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for in squad memory.' },
        limit: { type: 'number', description: 'Max number of results to return. Default 8, max 8.' }
      },
      required: ['query']
    },
    async execute(args, _ctx) {
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return 'search_squad_memory requires a non-empty "query" string argument.'
      }
      const limit =
        typeof args.limit === 'number'
          ? Math.max(1, Math.min(MAX_ENTRIES, Math.floor(args.limit)))
          : MAX_ENTRIES

      // Default to the local Flask bind; SQUAD_STORE_URL overrides (matches the
      // env var the rest of the squad tooling uses). The bare /api/search path
      // is what the local bind serves — the /squad/... prefix only exists on
      // the external funnel, so we deliberately do not add it here.
      const base = (process.env.SQUAD_STORE_URL ?? 'http://127.0.0.1:5005').replace(/\/+$/, '')
      // mode=literal: substring match, no vecgrep dependency — keeps the tool
      // deterministic and avoids vecgrep flakiness.
      const url = `${base}/api/search?q=${encodeURIComponent(query)}&mode=literal`

      // Abort the request if shared-memory hangs, so a stalled tool call cannot
      // wedge the whole tool-dispatch loop.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      let data: SquadSearchResponse
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: controller.signal
        })
        if (!res.ok) return `Squad memory search failed: HTTP ${res.status}.`
        data = (await res.json()) as SquadSearchResponse
      } catch (e: any) {
        if (e?.name === 'AbortError') {
          return `Squad memory search timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
        }
        return `Squad memory search error: ${e?.message ?? String(e)}`
      } finally {
        clearTimeout(timer)
      }

      const entries = Array.isArray(data?.entries) ? data.entries : []
      if (entries.length === 0) return `No squad memories matched "${query}".`

      const shown = entries.slice(0, limit)
      const total = typeof data.total === 'number' ? data.total : entries.length
      const lines = shown.map(m => {
        const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
        const raw = typeof m.text === 'string' ? m.text : ''
        const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) + '…' : raw
        return `#${m.id} (${m.type}) ${m.name}${tags}\n${text}`
      })
      return `shared-memory: ${shown.length} of ${total} match(es) for "${query}"\n\n${lines.join('\n\n')}`
    }
  }
}
