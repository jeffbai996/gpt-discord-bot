import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseResponse,
  normalizeJsonWhitespace,
  extractModelText,
} from '../../../src/providers/gemini/parse.ts'

// ---- parseResponse ----
// Note: gpt-bot's ParsedResponse shape is { react: string|null, reply: string }
// (no `thinking` field — that's gem-bot-specific). parseResponse maps the
// gem-bot JSON fields onto the gpt-bot shape: react→react, reply→reply,
// thinking is discarded.

describe('parseResponse', () => {
  test('parses both fields', () => {
    const r = parseResponse('{"react":"🦆","reply":"hello"}')
    assert.equal(r.react, '🦆')
    assert.equal(r.reply, 'hello')
  })

  test('parses reply-only', () => {
    const r = parseResponse('{"react":null,"reply":"text"}')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'text')
  })

  test('parses react-only (null reply becomes empty string)', () => {
    const r = parseResponse('{"react":"👍","reply":null}')
    assert.equal(r.react, '👍')
    // reply null from Gemini → empty string in gpt-bot's ParsedResponse
    assert.equal(r.reply, '')
  })

  test('falls back to reply for malformed JSON', () => {
    const r = parseResponse('not json at all')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'not json at all')
  })

  test('treats empty string react as null', () => {
    const r = parseResponse('{"react":"","reply":"hello"}')
    assert.equal(r.react, null)
    assert.equal(r.reply, 'hello')
  })

  test('ignores extra fields (thinking etc)', () => {
    const r = parseResponse('{"react":"✅","reply":"ok","thinking":"pondering"}')
    assert.equal(r.react, '✅')
    assert.equal(r.reply, 'ok')
  })

  test('strips ```json fences', () => {
    const r = parseResponse('```json\n{"react":"👍","reply":"hi"}\n```')
    assert.equal(r.react, '👍')
    assert.equal(r.reply, 'hi')
  })

  test('strips bare ``` fences', () => {
    const r = parseResponse('```\n{"react":null,"reply":"hi"}\n```')
    assert.equal(r.reply, 'hi')
  })

  test('extracts JSON object from preamble', () => {
    const r = parseResponse('Here is the response:\n{"react":null,"reply":"actual reply"}')
    assert.equal(r.reply, 'actual reply')
  })

  test('falls back when no JSON object is found', () => {
    const r = parseResponse('just plain text with no braces')
    assert.equal(r.reply, 'just plain text with no braces')
    assert.equal(r.react, null)
  })

  test('recovers from code-execution leakage (last {...} wins)', () => {
    const leaked = 'data = [(1, 2)]\n\n{"react":null,"reply":"Net gain $342,565"}'
    const r = parseResponse(leaked)
    assert.equal(r.reply, 'Net gain $342,565')
  })

  describe('newline-tolerant structural parsing', () => {
    test('tolerates newline between quote and key name', () => {
      const mangled = `{"\nreact": "😳", "reply": "yo"}`
      const r = parseResponse(mangled)
      assert.equal(r.react, '😳')
      assert.equal(r.reply, 'yo')
    })

    test('tolerates newlines between keys, colons, and values', () => {
      const mangled = `{
"react"
: "👍"
,
"reply"
: "hi"
}`
      const r = parseResponse(mangled)
      assert.equal(r.react, '👍')
      assert.equal(r.reply, 'hi')
    })

    test('preserves literal newlines inside string values', () => {
      const mangled = `{"react": null, "reply": "line one\nline two\n\nparagraph two"}`
      const r = parseResponse(mangled)
      assert.equal(r.reply, 'line one\nline two\n\nparagraph two')
    })

    test('preserves escaped newlines inside string values', () => {
      const r = parseResponse('{"react":null,"reply":"line one\\nline two"}')
      assert.equal(r.reply, 'line one\nline two')
    })

    test('real-world Gemini Apr 20 2026 output', () => {
      const mangled = `{"\nreact": "😳", "thinking": "Claudsson was looking at current/spot\nNQ or stale data.", "reply": "Yeah, Claudsson is tripping on the quote\n. He probably looked at spot NDX.\n\nNQ=F is in the 26,600s."}`
      const r = parseResponse(mangled)
      assert.equal(r.react, '😳')
      assert.match(r.reply ?? '', /Claudsson is tripping/)
      assert.match(r.reply ?? '', /\n\nNQ=F/)
    })
  })

  describe('isPartial mode', () => {
    test('extracts fields from truncated JSON string', () => {
      const truncated = '{"react":null,"thinking":"I am pondering this deeply","re'
      const r = parseResponse(truncated, true)
      assert.equal(r.react, null)
      // reply is null/partial — not yet emitted
      assert.equal(r.reply, null)
    })

    test('extracts multiple fields from truncated JSON', () => {
      const truncated = '{"react":"👍","thinking":"done thinking","reply":"here is the an'
      const r = parseResponse(truncated, true)
      assert.equal(r.react, '👍')
      assert.equal(r.reply, 'here is the an')
    })
  })
})

// ---- normalizeJsonWhitespace ----

describe('normalizeJsonWhitespace', () => {
  test('drops structural whitespace between tokens', () => {
    const input = '{\n"react"\n:\n"😀"\n}'
    const out = normalizeJsonWhitespace(input)
    // Should be parseable as JSON after normalization
    assert.doesNotThrow(() => JSON.parse(out))
    assert.equal(JSON.parse(out).react, '😀')
  })

  test('escapes literal newlines inside strings', () => {
    const input = '{"reply":"line one\nline two"}'
    const out = normalizeJsonWhitespace(input)
    // The literal \n in the string value must be escaped to \\n so JSON.parse accepts it
    const parsed = JSON.parse(out)
    assert.equal(parsed.reply, 'line one\nline two')
  })

  test('handles escaped quotes inside strings', () => {
    const input = '{"reply":"say \\"hello\\""}'
    const out = normalizeJsonWhitespace(input)
    const parsed = JSON.parse(out)
    assert.equal(parsed.reply, 'say "hello"')
  })

  test('idempotent on clean JSON', () => {
    const input = '{"react":null,"reply":"hello"}'
    const out = normalizeJsonWhitespace(input)
    assert.equal(JSON.parse(out).reply, 'hello')
  })
})

// ---- extractModelText ----

describe('extractModelText', () => {
  test('returns empty string for undefined parts', () => {
    assert.equal(extractModelText(undefined), '')
  })

  test('concatenates plain text parts with no separator', () => {
    assert.equal(
      extractModelText([{ text: 'hello ' }, { text: 'world' }]),
      'hello world'
    )
  })

  test('preserves leading whitespace in continuation parts', () => {
    assert.equal(
      extractModelText([{ text: 'I am' }, { text: ' a bot' }]),
      'I am a bot'
    )
  })

  test('drops executableCode parts', () => {
    const parts = [
      { executableCode: { language: 'PYTHON', code: 'print(1)' } } as any,
      { text: '{"reply":"real answer"}' }
    ]
    assert.equal(extractModelText(parts), '{"reply":"real answer"}')
  })

  test('drops codeExecutionResult parts', () => {
    const parts = [
      { codeExecutionResult: { outcome: 'OK', output: '1\n' } } as any,
      { text: '{"reply":"real answer"}' }
    ]
    assert.equal(extractModelText(parts), '{"reply":"real answer"}')
  })

  test('drops functionCall parts', () => {
    const parts = [
      { functionCall: { name: 'search', args: {} } } as any,
      { text: 'final text' }
    ]
    assert.equal(extractModelText(parts), 'final text')
  })

  test('skips thought parts (gemini-3 thinking models)', () => {
    const parts = [
      { text: 'thinking...', thought: true } as any,
      { text: '{"reply":"visible"}' }
    ]
    assert.equal(extractModelText(parts), '{"reply":"visible"}')
  })
})
