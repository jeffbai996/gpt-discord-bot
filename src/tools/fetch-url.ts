import type { Tool } from './registry.ts'
import { extractContent, truncate } from './fetch-url-internal.ts'
import { fetchPublicUrl } from './safe-http.ts'

const DEFAULT_MAX_CHARS = 8000
const HARD_MAX_CHARS = 50_000
const MAX_BODY_BYTES = 5 * 1024 * 1024

export const fetchUrlTool: Tool = {
  name: 'fetch_url',
  description: 'Fetch a public URL and return its main text content. Use when the user pastes a link or asks you to read a webpage. Supports HTML (article extraction), plain text, markdown, and JSON. Returns up to 8000 chars by default.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'public http(s) URL to fetch' },
      maxChars: { type: 'number', description: 'Optional cap on output size in characters. Default 8000, hard cap 50000.' }
    },
    required: ['url']
  },
  async execute(args, _ctx) {
    const rawUrl = args.url
    if (typeof rawUrl !== 'string') return 'fetch_url: url argument must be a string'
    const requestedMax = typeof args.maxChars === 'number' ? args.maxChars : DEFAULT_MAX_CHARS
    const maxChars = Math.min(Math.max(100, requestedMax), HARD_MAX_CHARS)

    let res: Awaited<ReturnType<typeof fetchPublicUrl>>
    try {
      res = await fetchPublicUrl(rawUrl, MAX_BODY_BYTES)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (e?.name === 'TimeoutError' || /timeout/i.test(msg)) return 'fetch_url: timed out after 15s'
      if (/refused/i.test(msg)) return 'fetch_url: connection refused'
      return `fetch_url: ${msg}`
    }

    if (res.status < 200 || res.status >= 300) {
      return `fetch_url: HTTP ${res.status} ${res.statusText}`
    }

    const extracted = await extractContent(res.buffer, res.contentType, res.url.toString())
    const titleLine = extracted.title ? `# ${extracted.title}\n` : ''
    const head = `${titleLine}${res.url.toString()}\n\n`
    return head + truncate(extracted.body, maxChars)
  }
}
