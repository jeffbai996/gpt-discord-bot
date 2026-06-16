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

// Cap how many entries we surface and how much body text each one contributes.
// Per-entry was 600 — far too small: the curated profiles are rich (the
// "Jeff's social network" entry is ~8900 chars), so a 600-char cut chopped each
// to a surface fragment BEFORE the relevant detail, which is exactly why the
// model "knew" people only surface-level. Raise the per-entry cap and bound the
// TOTAL instead, so the top (most relevant) hits come through whole and one
// huge entry can't blow the context. Sized to the live corpus (largest entry
// ~2.2k tok; a full multi-hit recall ~3.7k tok even uncapped). Ported from the
// gem-bot fix, 2026-06-16.
const MAX_ENTRIES = 8
const MAX_TEXT_CHARS = 10_000
const MAX_TOTAL_CHARS = 24_000
// A single by-id fetch is one record the user explicitly asked for, so allow a
// much larger slice — truncating a profile mid-record is what makes the model
// confabulate the missing half.
const MAX_TEXT_CHARS_BY_ID = 10_000
const FETCH_TIMEOUT_MS = 8000

// Caller scope for bot-visibility on the recency endpoint. gpt-bot is a family
// bot (default-allow), so this is informational, but pass it so restricted-bot
// rules stay correct if gpt is ever scoped.
const SQUAD_BOT = process.env.SQUAD_STORE_BOT || 'gpt'

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

// Render a list of entries under a TOTAL char budget, so the top hits come
// through whole rather than every hit chopped to a fragment. Each entry is also
// capped individually at MAX_TEXT_CHARS. Returns the rendered block + how many
// entries actually made it in.
function renderEntries(
  entries: SquadEntry[],
  scores: Record<string, number> = {}
): { block: string; rendered: number } {
  const lines: string[] = []
  let used = 0
  let rendered = 0
  for (const m of entries) {
    const tags = Array.isArray(m.tags) && m.tags.length ? ` [${m.tags.join(', ')}]` : ''
    const pct = scores[String(m.id)]
    const rel = typeof pct === 'number' ? ` ~${pct}% match` : ''
    const raw = typeof m.text === 'string' ? m.text : ''
    const text = raw.length > MAX_TEXT_CHARS ? raw.slice(0, MAX_TEXT_CHARS) + '…' : raw
    const line = `#${m.id} (${m.type}) ${m.name}${tags}${rel}\n${text}`
    if (rendered > 0 && used + line.length > MAX_TOTAL_CHARS) break
    lines.push(line)
    used += line.length
    rendered++
  }
  return { block: lines.join('\n\n'), rendered }
}

// Recency surface: newest memories first. Semantic/keyword search has no
// recency signal — "latest / newest / most recent project" matches topical-old
// records and never surfaces the actually-newest one. GET /api/recall?recent=1
// sorts by id desc server-side. Ported from the gem-bot fix, 2026-06-16.
async function fetchRecent(limit: number): Promise<string> {
  const url = `${squadBase()}/api/recall?recent=1&top_k=${limit}&bot=${encodeURIComponent(SQUAD_BOT)}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal
    })
    if (!res.ok) return `Squad memory recency fetch failed: HTTP ${res.status}.`
    const data = (await res.json()) as { entries?: SquadEntry[] }
    const entries = Array.isArray(data?.entries) ? data.entries : []
    if (entries.length === 0) return 'No squad memories found.'
    const { block } = renderEntries(entries)
    return `shared-memory: newest memories first\n\n${block}`
  } catch (e: any) {
    if (e?.name === 'AbortError') {
      return `Squad memory recency fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
    }
    return `Squad memory recency fetch error: ${e?.message ?? String(e)}`
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
      '- For "latest / newest / most recent project" or "what are we working on now", pass "recent": true — keyword search CANNOT answer recency, so you MUST use recent for those.\n' +
      '- Otherwise pass "query" to keyword-search by topic.\n' +
      'CRITICAL: only state what the returned record(s) actually say. Different memories can mention different people with similar names (e.g. several distinct "Dan"s). Do not merge or infer across records, and do not claim a record is "memory N" unless you fetched it by id=N. If unsure, say what you actually retrieved.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Fetch one exact memory by its numeric id. Use this whenever the user names a memory by number.' },
        recent: { type: 'boolean', description: 'Return the NEWEST memories first (ignores query). Use for "latest / most recent project" questions — search cannot answer recency.' },
        query: { type: 'string', description: 'Keywords to topic-search squad memory. Used only when "id" and "recent" are not given.' },
        limit: { type: 'number', description: 'Max number of results to return. Default 8, max 8.' }
      },
      required: []
    },
    async execute(args, _ctx) {
      const limitFor = (): number =>
        typeof args.limit === 'number'
          ? Math.max(1, Math.min(MAX_ENTRIES, Math.floor(args.limit)))
          : MAX_ENTRIES

      // By-id path: deterministic single-record fetch. Takes priority so
      // "read memory 84" resolves to record #84 instead of a fuzzy match.
      const id =
        typeof args.id === 'number' && Number.isInteger(args.id) && args.id > 0
          ? args.id
          : null
      if (id !== null) {
        return await fetchById(id)
      }

      // Recency path: newest-first. Search can't answer "latest", so this is a
      // distinct mode, checked before query.
      if (args.recent === true) {
        return await fetchRecent(limitFor())
      }

      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) {
        return 'search_squad_memory requires a numeric "id", "recent": true, or a non-empty "query" string argument.'
      }
      const limit = limitFor()

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
      // Render under the total-char budget so the top hits arrive whole instead
      // of every hit chopped to a 600-char fragment (the old surface-level bug).
      const { block, rendered } = renderEntries(shown, scores)
      const modeNote = data.mode && data.mode !== 'hybrid' ? ` (${data.mode} mode)` : ''
      return `shared-memory: ${rendered} of ${total} match(es) for "${query}"${modeNote}. Ranked by relevance; lower-ranked / low-% hits may be off-topic.\n\n${block}`
    }
  }
}
