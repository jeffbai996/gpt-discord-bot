import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Tool } from './registry.ts'

const execFileAsync = promisify(execFile)

// The `browse` CLI on this host auto-attaches to a persistent logged-in Chrome
// session over CDP when one is up, so it can read pages
// BEHIND A LOGIN without re-auth; otherwise it falls back to anonymous headless.
// Overridable for non-default installs.
const BROWSE_BIN = process.env.GPT_BROWSE_BIN || `${process.env.HOME}/.local/bin/browse`
const TIMEOUT_MS = 45_000
const OUT_CAP = 8000

// Why a separate tool from fetch_url: fetch_url does a plain HTTP GET (no JS, no
// cookies) — great for public articles, useless for anything that needs the user's
// session or client-side rendering. `browse` drives a real (logged-in) Chrome, so
// it sees JS-rendered and authenticated pages. The model picks based on whether
// the page needs a login / heavy JS.
export const browseTool: Tool = {
  name: 'browse',
  description:
    'Read a web page through a real browser session on this host. Use this instead of fetch_url when the page needs a login, renders content with JavaScript, or fetch_url returned an empty/blocked result. Returns the page\'s visible text (up to ~8000 chars). Read-only — it never clicks, types, or submits.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL to open and read.' },
    },
    required: ['url'],
  },
  async execute(args, _ctx): Promise<string> {
    const url = args.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      return 'browse: url must be an http(s) URL'
    }
    try {
      // url is passed as an argv element (not interpolated into a shell string),
      // so it can't break out into shell metacharacters.
      const { stdout } = await execFileAsync(BROWSE_BIN, ['text', url], {
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      })
      const out = (stdout || '').trim()
      if (!out) return 'browse: page produced no readable text'
      return out.length > OUT_CAP ? `${out.slice(0, OUT_CAP)}\n…(truncated)` : out
    } catch (e: any) {
      // browse exits non-zero on nav/render error; surface its stderr if present.
      const msg = e?.stderr?.toString?.().trim() || e?.message || String(e)
      return `browse: ${msg.slice(0, 400)}`
    }
  },
}
