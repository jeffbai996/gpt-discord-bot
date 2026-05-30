import type { Tool } from './registry.ts'

// Shapes returned by shared-memory GET /api/files and /api/files/:id, served on
// the local Flask bind at http://127.0.0.1:5005. The /squad/... prefix only
// exists on the external funnel, so we use the bare /api path here.
interface FileEntry {
  id: number
  name: string
  type: string
  mime: string
  size: number
  storage: string // "inline" | "blob"
  content?: string
  tags: string[]
  about: string[]
  ts: string
}

const MAX_LIST = 20
const MAX_CONTENT_CHARS = 8000
const FETCH_TIMEOUT_MS = 8000

function fmtSize(n: number): string {
  let v = typeof n === 'number' ? n : 0
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024 || unit === 'GB') {
      return unit === 'B' ? `${v}B` : `${v.toFixed(1)}${unit}`
    }
    v /= 1024
  }
  return `${v}B`
}

// Read-only tool: list/search the shared squad files or read one file's text.
// Needs no OpenAI client or local store — just native fetch — so the factory
// takes no args (matches makeSquadMemoryTool).
export function makeSquadFilesTool(): Tool {
  return {
    name: 'read_squad_file',
    description:
      'Access the shared squad files store — whole documents (references, specs, deep-dives, notes) dropped for the whole squad to read. Distinct from search_squad_memory (short facts) and search_memory (chat history). Call with no arguments to list files, with `query` to search by name/tags/content, or with `id` to read that file’s full text. Read-only.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional keyword(s) to search file names, tags, and content.' },
        id: { type: 'number', description: "A file id (from a prior list/search) to read that file's content." }
      },
      required: []
    },
    async execute(args, _ctx) {
      const base = (process.env.SQUAD_STORE_URL ?? 'http://127.0.0.1:5005').replace(/\/+$/, '')
      const id = typeof args.id === 'number' && Number.isFinite(args.id) ? args.id : undefined
      const query = typeof args.query === 'string' && args.query.trim().length ? args.query.trim() : undefined

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const doFetch = async (path: string): Promise<any> => {
        const res = await fetch(`${base}${path}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: controller.signal
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return await res.json()
      }

      try {
        // Read one file's content.
        if (id !== undefined) {
          const data = await doFetch(`/api/files/${id}`)
          const f: FileEntry | undefined = data?.file
          if (!f) return `No squad file with id ${id}.`
          if (f.storage !== 'inline') {
            return `#${f.id} ${f.name} is a ${f.mime} file (${fmtSize(f.size)}); not text-readable here. Raw bytes at /api/files/${f.id}/raw.`
          }
          let body = (f.content ?? '').trim()
          if (body.length > MAX_CONTENT_CHARS) body = body.slice(0, MAX_CONTENT_CHARS) + '\n…(truncated)'
          const tags = Array.isArray(f.tags) && f.tags.length ? ` [${f.tags.join(', ')}]` : ''
          return `#${f.id} ${f.name} (${f.type})${tags}\n\n${body}`
        }

        // List or search file metadata.
        const path = query ? `/api/files?q=${encodeURIComponent(query)}` : '/api/files'
        const data = await doFetch(path)
        const files: FileEntry[] = Array.isArray(data?.files) ? data.files : []
        if (files.length === 0) return query ? `No squad files matched "${query}".` : 'No squad files yet.'
        const shown = files.slice(0, MAX_LIST)
        const lines = shown.map(f => {
          const tags = Array.isArray(f.tags) && f.tags.length ? ` [${f.tags.join(', ')}]` : ''
          return `#${f.id} ${f.name} (${f.type}, ${fmtSize(f.size)})${tags}`
        })
        const header = query
          ? `squad-files: ${shown.length} match(es) for "${query}" — call again with the id to read one`
          : `squad-files: ${shown.length} file(s) — call again with the id to read one`
        return `${header}\n${lines.join('\n')}`
      } catch (e: any) {
        if (e?.name === 'AbortError') return `Squad files request timed out after ${FETCH_TIMEOUT_MS / 1000}s.`
        return `Squad files error: ${e?.message ?? String(e)}`
      } finally {
        clearTimeout(timer)
      }
    }
  }
}
