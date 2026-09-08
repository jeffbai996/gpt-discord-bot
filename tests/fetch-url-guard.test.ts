import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIp, validateUrl, extractContent, truncate } from '../src/tools/fetch-url-internal.ts'
import { fetchPublicUrl, resolvePublicAddress, type PinnedResponse } from '../src/tools/safe-http.ts'

// These tests extend tools.test.ts with edge cases for the SSRF guard and the
// content-type router, covering isPrivateIp including CGNAT (100.64.0.0/10,
// the Tailscale range), which the guard blocks.

// ─────────────────────────── isPrivateIp: IPv4 boundaries ───────────────────────────

test('isPrivateIp: 10/8 boundaries', () => {
  assert.equal(isPrivateIp('10.0.0.0'), true)
  assert.equal(isPrivateIp('10.255.255.255'), true)
  assert.equal(isPrivateIp('11.0.0.0'), false)
  assert.equal(isPrivateIp('9.255.255.255'), false)
})

test('isPrivateIp: 172.16/12 boundaries', () => {
  assert.equal(isPrivateIp('172.15.255.255'), false)
  assert.equal(isPrivateIp('172.16.0.0'), true)
  assert.equal(isPrivateIp('172.31.255.255'), true)
  assert.equal(isPrivateIp('172.32.0.0'), false)
})

test('isPrivateIp: 0.0.0.0 (this-host) treated as private', () => {
  // The "unspecified" address can route to localhost on some stacks; the guard
  // refuses it.
  assert.equal(isPrivateIp('0.0.0.0'), true)
  assert.equal(isPrivateIp('0.1.2.3'), true) // entire 0/8 is non-routable
})

test('isPrivateIp: link-local 169.254/16', () => {
  assert.equal(isPrivateIp('169.254.0.1'), true)
  assert.equal(isPrivateIp('169.255.0.1'), false)
  assert.equal(isPrivateIp('169.253.0.1'), false)
})

test('isPrivateIp: public addresses', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false)
  assert.equal(isPrivateIp('1.1.1.1'), false)
  assert.equal(isPrivateIp('93.184.216.34'), false)
})

test('isPrivateIp: CGNAT 100.64/10 classified private (Tailscale range)', () => {
  // RFC 6598 shared address space (100.64.0.0/10) is SSRF-relevant — Tailscale
  // assigns tailnet addresses from this range, so the guard must block it.
  assert.equal(isPrivateIp('100.64.0.1'), true)
  assert.equal(isPrivateIp('100.127.255.255'), true)
  // /10 boundaries: 100.0–63 and 100.128–255 are public.
  assert.equal(isPrivateIp('100.63.255.255'), false)
  assert.equal(isPrivateIp('100.128.0.0'), false)
})

test('isPrivateIp: malformed IPv4 returns false', () => {
  assert.equal(isPrivateIp('999.999.999.999'), false)
  assert.equal(isPrivateIp('10.0.0'), false)        // too few octets
  assert.equal(isPrivateIp('10.0.0.0.0'), false)    // too many octets
  assert.equal(isPrivateIp('not.an.ip.addr'), false)
  assert.equal(isPrivateIp(''), false)
})

test('isPrivateIp: octet out of range returns false', () => {
  assert.equal(isPrivateIp('10.0.0.256'), false)
  assert.equal(isPrivateIp('10.-1.0.0'), false)
})

// ─────────────────────────── isPrivateIp: IPv6 ───────────────────────────

test('isPrivateIp: IPv6 loopback and unspecified', () => {
  assert.equal(isPrivateIp('::1'), true)
  assert.equal(isPrivateIp('::'), true)
})

test('isPrivateIp: IPv6 unique-local fc00::/7', () => {
  assert.equal(isPrivateIp('fc00::1'), true)
  assert.equal(isPrivateIp('fd12:3456::1'), true)
  assert.equal(isPrivateIp('FC00::1'), true) // case-insensitive
})

test('isPrivateIp: IPv6 link-local fe80::/10', () => {
  assert.equal(isPrivateIp('fe80::1'), true)
  assert.equal(isPrivateIp('fe80::abcd:1234'), true)
  assert.equal(isPrivateIp('FEA0::1'), true)  // fea is in [89ab] bucket
})

test('isPrivateIp: IPv6 public global unicast', () => {
  assert.equal(isPrivateIp('2606:4700::1111'), false)
  assert.equal(isPrivateIp('2001:4860:4860::8888'), false)
})

test('isPrivateIp: IPv4-mapped IPv6 inherits IPv4 verdict', () => {
  assert.equal(isPrivateIp('::ffff:127.0.0.1'), true)
  assert.equal(isPrivateIp('::ffff:10.0.0.5'), true)
  assert.equal(isPrivateIp('::ffff:8.8.8.8'), false)
  assert.equal(isPrivateIp('::FFFF:192.168.1.1'), true) // case-insensitive prefix
  assert.equal(isPrivateIp('::ffff:7f00:1'), true)
  assert.equal(isPrivateIp('0:0:0:0:0:ffff:a9fe:a9fe'), true)
})

// ─────────────────────────── validateUrl ───────────────────────────

test('validateUrl: accepts http and https', () => {
  assert.equal(validateUrl('http://example.com').url.protocol, 'http:')
  assert.equal(validateUrl('https://example.com').url.protocol, 'https:')
})

test('validateUrl: rejects ftp/data/ws schemes', () => {
  assert.throws(() => validateUrl('ftp://host/file'), /unsupported scheme/)
  assert.throws(() => validateUrl('data:text/plain,hi'), /unsupported scheme/)
  assert.throws(() => validateUrl('ws://host'), /unsupported scheme/)
})

test('validateUrl: rejects garbage', () => {
  assert.throws(() => validateUrl(''), /invalid URL/)
  assert.throws(() => validateUrl('   '), /invalid URL/)
})

test('resolvePublicAddress rejects a hostname when any DNS answer is private', async () => {
  await assert.rejects(
    () => resolvePublicAddress(new URL('https://public.example'), async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /private network/,
  )
})

test('fetchPublicUrl revalidates redirects before issuing the next request', async () => {
  const requested: string[] = []
  const response = (status: number, location?: string): PinnedResponse => ({
    status,
    statusText: 'Found',
    headers: { get: name => name === 'location' ? location ?? null : null },
    body: (async function* () {})(),
    destroy() {},
  })

  await assert.rejects(
    () => fetchPublicUrl('https://public.example/start', 1024, {
      lookup: async hostname => hostname === 'public.example'
        ? [{ address: '93.184.216.34', family: 4 }]
        : [{ address: '127.0.0.1', family: 4 }],
      request: async url => {
        requested.push(url.toString())
        return response(302, 'http://internal.example/admin')
      },
    }),
    /private network/,
  )
  assert.deepEqual(requested, ['https://public.example/start'])
})

// ─────────────────────────── extractContent: content-type routing ───────────────────────────

test('extractContent: markdown passthrough', async () => {
  const r = await extractContent(Buffer.from('# Title\n\nbody'), 'text/markdown', 'https://x')
  assert.equal(r.contentType, 'markdown')
  assert.equal(r.body, '# Title\n\nbody')
})

test('extractContent: x-markdown variant', async () => {
  const r = await extractContent(Buffer.from('text'), 'text/x-markdown', 'https://x')
  assert.equal(r.contentType, 'markdown')
})

test('extractContent: +json suffix routes to json', async () => {
  const r = await extractContent(Buffer.from('{"ok":true}'), 'application/vnd.api+json', 'https://x')
  assert.equal(r.contentType, 'json')
  assert.match(r.body, /"ok": true/)
})

test('extractContent: malformed JSON falls back to raw body', async () => {
  const r = await extractContent(Buffer.from('{not valid json'), 'application/json', 'https://x')
  assert.equal(r.contentType, 'json')
  assert.equal(r.body, '{not valid json')
})

test('extractContent: content-type with charset param is stripped', async () => {
  const r = await extractContent(Buffer.from('plain'), 'text/plain; charset=utf-8', 'https://x')
  assert.equal(r.contentType, 'text')
  assert.equal(r.body, 'plain')
})

test('extractContent: unknown content type is unsupported', async () => {
  const r = await extractContent(Buffer.from('binary'), 'application/octet-stream', 'https://x')
  assert.equal(r.contentType, 'unsupported')
  assert.match(r.body, /unsupported content type/)
})

test('extractContent: empty content-type header is unsupported', async () => {
  const r = await extractContent(Buffer.from('x'), '', 'https://x')
  assert.equal(r.contentType, 'unsupported')
})

// ─────────────────────────── truncate ───────────────────────────

test('truncate: exact-length string is unchanged', () => {
  assert.equal(truncate('abc', 3), 'abc')
})

test('truncate: under limit unchanged', () => {
  assert.equal(truncate('ab', 5), 'ab')
})

test('truncate: over limit appends note with the char count', () => {
  const out = truncate('a'.repeat(10), 4)
  assert.ok(out.startsWith('aaaa'))
  assert.match(out, /truncated to 4 chars/)
})
