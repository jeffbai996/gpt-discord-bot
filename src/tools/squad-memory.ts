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
  // Per-id relevance percentage when the mode used the vector index. Lets the
  // caller see how strong each match actually is instead of treating rank-1 as
  // necessarily relevant.
  semantic_scores?: Record<string, number>
}

// Cap how many entries we surface and how much body text each one contributes,
// so a broad query cannot flood the model context window.
const MAX_ENTRIES = 8
const MAX_TEXT_CHARS = 600
// A single by-id fetch is one record the user explicitly asked for, so allow a
// much larger slice — truncating a profile mid-record is what makes the model
// confabulate the missing half.
const MAX_TEXT_CHARS_BY_ID = 4000
const FETCH_TIMEOUT_MS = 8000

function squadBase(): string {
  // Default to the local Flask bind; SQUAD_STORE_URL overrides. The bare /api
  // paths are what the local bind serves — the /squad/... prefix only exists on
  // the external funnel, so we deliberately do not add it here.
  return (process.env.SQUAD_STORE_URL ?? 'http://127.0.0.1:5005').replace(/\/+$/, '')
}

// Deterministic single-record fetch via GET /api/memory/<id>. Returns the full
// record verbatim so the model reports exactly what is stored, not a guess.
async function fetchById(id: number): Promise<string> {
  const url = `${squadBase()}/api/memory/${id}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    })
    if (res.status === 404) return `No squad memory has id #${id}.`
    if (!res.ok) return `Squad memory fetch failed: HTTP ${res.status}.`
    const body = (await res.json()) as { memory?: SquadEntry }
    const m = body?.memory
    if (!m || typeof m.id !== 'number') return `No squad memory has id #${id}.`
    const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
    const raw = typeof m.text === 'string' ? m.text : ''
    const text = raw.length > MAX_TEXT_CHARS_BY_ID ? raw.slice(0, MAX_TEXT_CHARS_BY_ID) + '…' : raw
    return `shared-memory memory #${m.id} (${m.type}) ${m.name}${tags}\n\n${text}`
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return `Squad memory fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
    }
    return `Squad memory fetch error: ${e?.message ?? String(e)}`
  } finally {
    clearTimeout(timer)
  }
}

// Read-only tool: searches the shared shared-memory memory over HTTP. Unlike
// makeSearchMemoryTool it needs no OpenAI client or local store — just native
// fetch + an env-overridable base URL — so the factory takes no args.
export function makeSquadMemoryTool(): Tool {
  return {
    name: 'search_squad_memory',
    description:
      'Read the shared shared-memory memory (durable facts about the user, their projects, portfolio, and the bot squad). Read-only.\n' +
      '- When the user references a memory by NUMBER ("memory 84", "read #84", "what does 84 say"), pass that number as "id" to fetch that EXACT record. Do not keyword-search for the number — that returns the wrong record.\n' +
      '- Otherwise pass "query" to keyword-search by substring.\n' +
      'CRITICAL: only state what the returned record(s) actually say. Different memories can mention different people with similar names (e.g. several distinct "Dan"s). Do not merge or infer across records, and do not claim a record is "memory N" unless you fetched it by id=N. If unsure, say what you actually retrieved.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Fetch one exact memory by its numeric id. Use this whenever the user names a memory by number.' },
        query: { type: 'string', description: 'Keywords to substring-search squad memory. Used only when "id" is not given.' },
        limit: { type: 'number', description: 'Max number of results to return. Default 8, max 8.' }
      },
      required: []
    },
    async execute(args, _ctx) {
      // By-id path: deterministic single-record fetch. Takes priority over query
      // so "read memory 84" resolves to record #84 instead of a fuzzy match.
      const id =
        typeof args.id === 'number' && Number.isInteger(args.id) && args.id > 0
          ? args.id
          : null
      if (id !== null) {
        return await fetchById(id)
      }

      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return 'search_squad_memory requires either a numeric "id" or a non-empty "query" string argument.'
      }
      const limit =
        typeof args.limit === 'number'
          ? Math.max(1, Math.min(MAX_ENTRIES, Math.floor(args.limit)))
          : MAX_ENTRIES

      const base = squadBase()
      // mode=hybrid: vector embeddings (semantic) fused with BM25 (keyword).
      // Strictly better recall than literal substring — it finds records by
      // meaning, so "Jeff's wife" surfaces the 蛋 profile even though the word
      // "wife" never appears in it. shared-memory falls back to literal on its
      // own when the vector index is unavailable.
      const url = `${base}/api/search?q=${encodeURIComponent(query)}&mode=hybrid`

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
      const scores = data.semantic_scores ?? {}
      const lines = shown.map(m => {
        const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
        // Relevance % when the vector index ranked this hit. Low scores flag a
        // weak match the model should not over-trust.
        const pct = scores[String(m.id)]
        const rel = typeof pct === 'number' ? ` ~${pct}% match` : ''
        const raw = typeof m.text === 'string' ? m.text : ''
        const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) + '…' : raw
        return `#${m.id} (${m.type}) ${m.name}${tags}${rel}\n${text}`
      })
      const modeNote = data.mode && data.mode !== 'hybrid' ? ` (${data.mode} mode)` : ''
      return `shared-memory: ${shown.length} of ${total} match(es) for "${query}"${modeNote}. Ranked by relevance; lower-ranked / low-% hits may be off-topic.\n\n${lines.join('\n\n')}`
    }
  }
}
