// Pure Gemini response-parsing helpers. Ported verbatim from gem-bot/src/gemini.ts
// (the functions are pure, no SDK dependency). Adapted to gpt-bot's ParsedResponse
// shape: { react: string|null, reply: string } (no `thinking` field — gem-bot-specific).
//
// Why these exist: Gemini + tools can't be held to strict JSON output. It may:
//   - Wrap JSON in ```json fences
//   - Prepend preamble text before the JSON object
//   - Insert literal newlines between JSON structural tokens
//   - Emit literal newlines inside string values (spec forbids, but it happens)
// This module handles all of those cases so the caller gets clean {react, reply}.

import type { ParsedResponse } from '../../core/provider.ts'

// Gem-bot's internal parsed shape (superset — includes `thinking` and nullable
// `reply`). We project to gpt-bot's ParsedResponse after extraction.
interface GemParsed {
  react: string | null
  thinking: string | null
  reply: string | null
}

function normalize(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// Find the last balanced top-level {...} block in `s`. Needed because with
// tools enabled (googleSearch/codeExecution), Gemini can't be held to strict
// JSON output — it may wrap in ```json fences, prepend preamble text, or leak
// code-execution output alongside the JSON. Returns the JSON substring or null.
function extractJsonObject(s: string): string | null {
  // Cheap path: whole string is already valid JSON
  const trimmed = s.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed

  // Walk from the end backward to find the last balanced {...}. Last, not first,
  // because code-exec output can contain earlier {} noise; the model's final
  // JSON answer comes after.
  let depth = 0
  let end = -1
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i]
    if (c === '}') {
      if (end === -1) end = i
      depth++
    } else if (c === '{') {
      depth--
      if (depth === 0 && end !== -1) return s.slice(i, end + 1)
    }
  }
  return null
}

// Gemini's streaming output routinely violates JSON spec in two ways:
// 1. Literal newlines between structural tokens (even between `"` and the
//    first char of a key — breaks JSON.parse and the "key" regex)
// 2. Literal newlines inside string VALUES (JSON spec requires \n escape)
//
// This pre-normalizer state-machines the input: outside strings, drops
// whitespace between tokens; inside strings, escapes control chars so
// JSON.parse accepts them (and we get the original newlines back via the
// parse's own unescaping).
export function normalizeJsonWhitespace(s: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) {
        out += c
        escaped = false
        continue
      }
      if (c === '\\') {
        out += c
        escaped = true
        continue
      }
      if (c === '"') {
        out += c
        inString = false
        continue
      }
      // Control chars INSIDE strings need to be escaped to produce valid JSON.
      if (c === '\n') { out += '\\n'; continue }
      if (c === '\r') { out += '\\r'; continue }
      out += c
    } else {
      if (c === '"') {
        inString = true
        out += c
      } else if (c === '\n' || c === '\r' || c === '\t') {
        // drop — whitespace between tokens, not inside a value
      } else {
        out += c
      }
    }
  }
  return out
}

// When tools (googleSearch/codeExecution) are enabled, the response is a
// multi-part Content: tool-output parts (executableCode, codeExecutionResult,
// functionCall) interleaved with the model's final text. Extract ONLY the text
// parts; drop everything else. Concatenate with EMPTY string (not '\n') —
// streaming responses split a single logical text output across multiple parts
// at token boundaries; joining with '\n' injects spurious newlines.
export function extractModelText(
  parts: Array<{ text?: string, executableCode?: unknown, codeExecutionResult?: unknown, functionCall?: unknown, thought?: boolean }> | undefined
): string {
  if (!parts) return ''
  const chunks: string[] = []
  for (const p of parts) {
    // Skip thought-summary parts (gemini-3 thinking models).
    if (p.thought === true) continue
    if (typeof p.text === 'string' && !p.executableCode && !p.codeExecutionResult && !p.functionCall) {
      chunks.push(p.text)
    }
  }
  return chunks.join('')
}

// Parse the gem-bot JSON shape {react, thinking, reply} from a response string.
// Returns the gem-bot internal shape so the caller can read all three fields.
// On any parse failure, falls back to treating the whole string as the reply.
function parseGemResponse(text: string, isPartial: boolean = false): GemParsed {
  let cleaned = text.trim()
  const fence = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?(?:```)?$/i)
  if (fence) cleaned = fence[1].trim()

  const jsonStr = extractJsonObject(cleaned)
  if (jsonStr) {
    try {
      const obj = JSON.parse(normalizeJsonWhitespace(jsonStr))
      // Gemini sometimes inserts whitespace INSIDE key names (e.g. `{"\nreact": ...}`).
      // Trim keys and reassemble so obj.react lookups work.
      const trimmed: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) trimmed[k.trim()] = v
      return {
        react: normalize(trimmed.react),
        thinking: normalize(trimmed.thinking),
        reply: normalize(trimmed.reply),
      }
    } catch {
      // fall through to regex extraction
    }
  }

  // Regex extraction fallback: works for partial streams AND broken JSON
  // (e.g. literal newlines in strings that normalizeJsonWhitespace still fails on)
  const extractString = (key: string) => {
    const regex = new RegExp(`"${key}"\\s*:\\s*"([^]*?)(?<!\\\\)"(?:\\s*,|\\s*})`, 'i')
    const unescapeLiteralEscapes = (s: string): string =>
      s.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')

    const match = cleaned.match(regex)
    if (match) {
      try {
        const sanitized = match[1].replace(/\n/g, '\\n').replace(/\r/g, '\\r')
        return JSON.parse(`"${sanitized}"`)
      } catch {
        return unescapeLiteralEscapes(match[1])
      }
    }

    if (isPartial) {
      const openRegex = new RegExp(`"${key}"\\s*:\\s*"([^]*)`, 'i')
      const openMatch = cleaned.match(openRegex)
      if (openMatch) {
        let val = openMatch[1]
        if (val.endsWith('}')) val = val.slice(0, -1).trim()
        if (val.endsWith('"')) val = val.slice(0, -1)
        try {
          const sanitized = val.replace(/\n/g, '\\n').replace(/\r/g, '\\r')
          return JSON.parse(`"${sanitized}"`)
        } catch {
          return unescapeLiteralEscapes(val)
        }
      }
    }
    return null
  }

  const react = extractString('react')
  const thinking = extractString('thinking')
  const reply = extractString('reply')

  if (!reply && !isPartial && !react && !thinking) {
    return { react: null, thinking: null, reply: cleaned || null }
  }

  return { react, thinking, reply }
}

// Parse a Gemini response text into gpt-bot's ParsedResponse shape.
// Ported from gem-bot's parseResponse, then projected to {react, reply}
// (dropping `thinking` which is gem-bot-specific).
//
// isPartial=true: called during streaming, extracts in-flight values even
// when the JSON is incomplete. reply may be null until the stream finishes.
export function parseResponse(text: string, isPartial: boolean = false): ParsedResponse {
  if (!text) return { react: null, reply: '' }
  const gem = parseGemResponse(text, isPartial)
  return {
    react: gem.react ?? null,
    // gpt-bot's ParsedResponse.reply is string, not string|null.
    // During partial streaming the caller handles null as "not yet".
    reply: gem.reply ?? (isPartial ? null as any : ''),
  }
}
