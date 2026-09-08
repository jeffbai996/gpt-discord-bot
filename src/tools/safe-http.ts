import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'

import { isPrivateIp, validateUrl } from './fetch-url-internal.ts'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export interface ResolvedAddress {
  address: string
  family: number
}

export interface PinnedResponse {
  status: number
  statusText: string
  headers: { get(name: string): string | null }
  body: AsyncIterable<Uint8Array>
  destroy(): void
}

export interface SafeHttpDependencies {
  lookup?: (hostname: string) => Promise<ResolvedAddress[]>
  request?: (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<PinnedResponse>
}

export interface SafeHttpResult {
  buffer: Buffer
  contentType: string
  status: number
  statusText: string
  url: URL
}

export async function resolvePublicAddress(
  url: URL,
  lookup: (hostname: string) => Promise<ResolvedAddress[]> = hostname =>
    dns.lookup(hostname, { all: true, verbatim: true }),
): Promise<ResolvedAddress> {
  const addresses = await lookup(url.hostname)
  if (addresses.length === 0) throw new Error('host resolved to no addresses')
  if (addresses.some(result => isPrivateIp(result.address))) {
    throw new Error('refusing to fetch private network address')
  }
  return addresses[0]
}

export async function fetchPublicUrl(
  rawUrl: string,
  maxBodyBytes: number,
  dependencies: SafeHttpDependencies = {},
): Promise<SafeHttpResult> {
  let url = validateUrl(rawUrl).url
  if (url.username || url.password) throw new Error('URL credentials are not allowed')
  const lookup = dependencies.lookup ?? (hostname => dns.lookup(hostname, { all: true, verbatim: true }))
  const request = dependencies.request ?? requestPinned
  const signal = AbortSignal.timeout(15_000)

  for (let redirects = 0; ; redirects += 1) {
    const address = await resolvePublicAddress(url, lookup)
    const response = await request(url, address, signal)
    const location = response.headers.get('location')
    if (REDIRECT_STATUSES.has(response.status) && location) {
      response.destroy()
      if (redirects >= MAX_REDIRECTS) throw new Error('too many redirects')
      url = validateUrl(new URL(location, url).toString()).url
      if (url.username || url.password) throw new Error('URL credentials are not allowed')
      continue
    }

    if (response.status < 200 || response.status >= 300) {
      response.destroy()
      return {
        buffer: Buffer.alloc(0),
        contentType: response.headers.get('content-type') ?? '',
        status: response.status,
        statusText: response.statusText,
        url,
      }
    }

    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      response.destroy()
      throw new Error(`response body exceeded ${Math.floor(maxBodyBytes / 1024 / 1024)}MB cap`)
    }

    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body) {
      total += chunk.byteLength
      if (total > maxBodyBytes) {
        response.destroy()
        throw new Error(`response body exceeded ${Math.floor(maxBodyBytes / 1024 / 1024)}MB cap`)
      }
      chunks.push(Buffer.from(chunk))
    }
    return {
      buffer: Buffer.concat(chunks, total),
      contentType: response.headers.get('content-type') ?? '',
      status: response.status,
      statusText: response.statusText,
      url,
    }
  }
}

function requestPinned(
  url: URL,
  address: ResolvedAddress,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const options = {
      method: 'GET',
      signal,
      autoSelectFamily: false,
      headers: {
        'User-Agent': 'gpt-bot/1.0',
        'Accept': 'text/html,text/plain,text/markdown,application/json,*/*;q=0.8',
      },
      lookup: (_hostname, _options, callback) => {
        if (typeof _options === 'object' && _options.all) {
          ;(callback as any)(null, [{ address: address.address, family: address.family }])
          return
        }
        ;(callback as any)(null, address.address, address.family)
      },
    } as http.RequestOptions & { autoSelectFamily: boolean }
    const req = transport.request(url, options, response => {
      resolve({
        status: response.statusCode ?? 0,
        statusText: response.statusMessage ?? '',
        headers: {
          get(name: string): string | null {
            const value = response.headers[name.toLowerCase()]
            return Array.isArray(value) ? value[0] ?? null : value ?? null
          },
        },
        body: response,
        destroy: () => response.destroy(),
      })
    })
    req.once('error', reject)
    req.end()
  })
}
