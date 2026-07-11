import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStructuredReply, extractPartialReply, previewToolResult, maxToolLoops } from '../src/openai.ts'

test('maxToolLoops: defaults to 24 rounds', () => {
  assert.equal(maxToolLoops(undefined), 24)
  assert.equal(maxToolLoops(''), 24)
})

test('maxToolLoops: accepts a positive integer override', () => {
  assert.equal(maxToolLoops('40'), 40)
})

test('maxToolLoops: rejects invalid and unsafe overrides', () => {
  assert.equal(maxToolLoops('0'), 24)
  assert.equal(maxToolLoops('-1'), 24)
  assert.equal(maxToolLoops('12.5'), 24)
  assert.equal(maxToolLoops('garbage'), 24)
})

test('parseStructuredReply: well-formed JSON', () => {
  const out = parseStructuredReply('{"react": "👍", "reply": "hello"}')
  assert.equal(out.react, '👍')
  assert.equal(out.reply, 'hello')
})

test('parseStructuredReply: null react becomes null', () => {
  const out = parseStructuredReply('{"react": null, "reply": "ok"}')
  assert.equal(out.react, null)
  assert.equal(out.reply, 'ok')
})

test('parseStructuredReply: empty-string react becomes null', () => {
  const out = parseStructuredReply('{"react": "", "reply": "x"}')
  assert.equal(out.react, null)
})

test('parseStructuredReply: strips json code fence', () => {
  const out = parseStructuredReply('```json\n{"react": "🔥", "reply": "hot"}\n```')
  assert.equal(out.react, '🔥')
  assert.equal(out.reply, 'hot')
})

test('parseStructuredReply: bare code fence (no language)', () => {
  const out = parseStructuredReply('```\n{"react": null, "reply": "x"}\n```')
  assert.equal(out.reply, 'x')
})

test('parseStructuredReply: trailing prose after JSON', () => {
  const out = parseStructuredReply('{"react": null, "reply": "hi"} (done)')
  assert.equal(out.reply, 'hi')
})

test('parseStructuredReply: completely malformed → treats all as reply', () => {
  const out = parseStructuredReply('this is just prose, no JSON at all')
  assert.equal(out.react, null)
  assert.equal(out.reply, 'this is just prose, no JSON at all')
})

test('parseStructuredReply: empty string → empty reply', () => {
  const out = parseStructuredReply('')
  assert.equal(out.react, null)
  assert.equal(out.reply, '')
})

test('extractPartialReply: returns null when reply key not yet present', () => {
  assert.equal(extractPartialReply('{"react": "👍"'), null)
  assert.equal(extractPartialReply(''), null)
})

test('extractPartialReply: extracts in-flight reply substring', () => {
  // Mid-stream: reply value is open and still growing.
  assert.equal(extractPartialReply('{"react": null, "reply": "hello wo'), 'hello wo')
})

test('extractPartialReply: handles closed reply string', () => {
  assert.equal(extractPartialReply('{"react": null, "reply": "hello"'), 'hello')
})

test('extractPartialReply: unescapes common sequences', () => {
  assert.equal(extractPartialReply('{"reply": "line1\\nline2'), 'line1\nline2')
  assert.equal(extractPartialReply('{"reply": "she said \\"hi\\"'), 'she said "hi"')
})

test('extractPartialReply: tolerates whitespace variations around colon', () => {
  assert.equal(extractPartialReply('{ "reply"   :   "x'), 'x')
})

test('previewToolResult: passes short strings through unchanged', () => {
  assert.equal(previewToolResult('hello world'), 'hello world')
})

test('previewToolResult: collapses internal whitespace', () => {
  assert.equal(previewToolResult('a\n\n  b\tc'), 'a b c')
})

test('previewToolResult: caps long strings at 120 chars with ellipsis', () => {
  const long = 'x'.repeat(200)
  const out = previewToolResult(long)
  assert.equal(out.length, 120)
  assert.ok(out.endsWith('...'))
  assert.equal(out, 'x'.repeat(117) + '...')
})

test('previewToolResult: JSON-stringifies non-string results', () => {
  assert.equal(previewToolResult({ a: 1, b: 'two' }), '{"a":1,"b":"two"}')
})

test('previewToolResult: empty string stays empty', () => {
  assert.equal(previewToolResult(''), '')
})
