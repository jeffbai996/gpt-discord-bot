import { BlockList } from 'node:net'

// jsdom is loaded lazily inside extractContent so the rest of this module
// (URL validation, IP guards, mime-routing) is usable on Node versions that
// don't satisfy jsdom's modern-ArrayBuffer requirements. The bot's runtime
// targets Node 22+; this just keeps the test suite green on older boxes.
//
// extractContent is sync because callers expect a sync return; we cache the
// loaded modules after the first use. The first HTML fetch pays a one-time
// cost to populate the cache, but that's also when JSDOM does its global
// stylesheet/parser init anyway.
type JSDOMCtor = new (input: string, opts?: { url?: string }) => {
  window: { document: any }
}
type ReadabilityCtor = new (doc: any) => {
  parse(): { title?: string; textContent?: string } | null
}

let _jsdomCache: { JSDOM: JSDOMCtor; Readability: ReadabilityCtor } | null = null
let _jsdomFailed = false

const PRIVATE_IPV4_BLOCKS = new BlockList()
PRIVATE_IPV4_BLOCKS.addSubnet('0.0.0.0', 8, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('127.0.0.0', 8, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE_IPV4_BLOCKS.addSubnet('192.168.0.0', 16, 'ipv4')

async function ensureJsdom(): Promise<{ JSDOM: JSDOMCtor; Readability: ReadabilityCtor } | null> {
  if (_jsdomCache) return _jsdomCache
  if (_jsdomFailed) return null
  try {
    const [j, r] = await Promise.all([
      import('jsdom'),
      import('@mozilla/readability')
    ])
    _jsdomCache = { JSDOM: j.JSDOM as unknown as JSDOMCtor, Readability: r.Readability as unknown as ReadabilityCtor }
    return _jsdomCache
  } catch {
    _jsdomFailed = true
    return null
  }
}

export interface ValidatedUrl { url: URL }

export function validateUrl(raw: string): ValidatedUrl {
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('invalid URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported scheme "${url.protocol}"`)
  }
  return { url }
}

// IPv4 private/loopback/link-local + IPv6 equivalents.
export function isPrivateIp(ip: string): boolean {
  // IPv4-mapped IPv6 like "::ffff:127.0.0.1" — fall through to IPv4 check.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return isPrivateIp(mapped[1])

  if (ip.includes(':')) {
    const lower = ip.toLowerCase()
    if (PRIVATE_IPV4_BLOCKS.check(lower, 'ipv6')) return true
    if (lower === '::1' || lower === '::') return true
    if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return true
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true
    return false
  }

  const parts = ip.split('.').map(p => parseInt(p, 10))
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 127) return true
  if (a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // RFC 6598 CGNAT shared space 100.64.0.0/10. Tailscale assigns tailnet
  // addresses from this range, so without it the bot could fetch internal
  // mesh services (other hosts, MCP endpoints) via a 100.x URL — SSRF.
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export interface ExtractedContent {
  title: string | null
  body: string
  contentType: 'html' | 'text' | 'markdown' | 'json' | 'unsupported'
}

export async function extractContent(buffer: Buffer, contentTypeHeader: string, url: string): Promise<ExtractedContent> {
  const ct = (contentTypeHeader || '').toLowerCase().split(';')[0].trim()

  if (ct === 'text/html' || ct === 'application/xhtml+xml') {
    const html = buffer.toString('utf8')
    const mod = await ensureJsdom()
    if (!mod) {
      return { title: null, body: '[HTML parser unavailable on this runtime]', contentType: 'unsupported' }
    }
    const { JSDOM, Readability } = mod
    try {
      const dom = new JSDOM(html, { url })
      const article = new Readability(dom.window.document).parse()
      if (article && article.textContent) {
        return {
          title: article.title?.trim() || null,
          body: article.textContent.trim(),
          contentType: 'html'
        }
      }
    } catch { /* fall through */ }
    try {
      const dom = new JSDOM(html)
      const doc = dom.window.document as any
      return {
        title: doc.title?.trim() || null,
        body: doc.body?.textContent?.trim() || '',
        contentType: 'html'
      }
    } catch {
      return { title: null, body: '[could not parse HTML]', contentType: 'unsupported' }
    }
  }

  if (ct === 'application/json' || ct.endsWith('+json')) {
    try {
      const parsed = JSON.parse(buffer.toString('utf8'))
      return { title: null, body: JSON.stringify(parsed, null, 2), contentType: 'json' }
    } catch {
      return { title: null, body: buffer.toString('utf8'), contentType: 'json' }
    }
  }

  if (ct === 'text/markdown' || ct === 'text/x-markdown') {
    return { title: null, body: buffer.toString('utf8'), contentType: 'markdown' }
  }

  if (ct.startsWith('text/')) {
    return { title: null, body: buffer.toString('utf8'), contentType: 'text' }
  }

  return { title: null, body: `[unsupported content type: ${ct || 'unknown'}]`, contentType: 'unsupported' }
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + `\n\n[truncated to ${maxChars} chars]`
}
