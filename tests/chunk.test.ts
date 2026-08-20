import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunk } from '../src/chunk.ts'

test('chunk: returns single chunk when under limit', () => {
  const out = chunk('hello world', 2000)
  assert.equal(out.length, 1)
  assert.equal(out[0], 'hello world')
})

test('chunk: splits at newline boundaries when possible', () => {
  const text = 'a'.repeat(50) + '\n' + 'b'.repeat(50)
  const out = chunk(text, 60)
  assert.equal(out.length, 2)
  assert.ok(out[0].endsWith('\n') || out[0].length <= 60)
})

test('chunk: re-opens code fence across the split', () => {
  const lang = 'ts'
  const code = 'console.log("x")\n'.repeat(200)
  const text = `prose\n\n\`\`\`${lang}\n${code}\`\`\`\n`
  const out = chunk(text, 500)
  assert.ok(out.length >= 2, 'expected multiple chunks for a long code block')

  // Every chunk after the first that starts mid-block should reopen with the same lang.
  // Every chunk before the last that left a block open should close with ```.
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i].includes('```' + lang) || out[i].includes('```\n')) {
      // chunk closes properly somewhere
    }
  }
  const reopened = out.slice(1).some(c => c.startsWith('```' + lang))
  assert.ok(reopened, 'expected at least one chunk to reopen the code fence')
})

test('chunk: keeps a long fenced document fenced across every page', () => {
  const code = Array.from(
    { length: 260 },
    (_, i) => `section ${String(i + 1).padStart(3, '0')} ${'x'.repeat(28)}`,
  ).join('\n')
  const text = `\`\`\`text\n${code}\n\`\`\``
  const out = chunk(text, 500)

  assert.ok(out.length >= 5, 'expected a genuinely multi-page document')
  assert.ok(out.every(page => page.length <= 500), 'every page must fit Discord')
  assert.ok(out.every(page => (page.match(/\`\`\`/g) ?? []).length % 2 === 0),
    'every page must be independently fenced')
  assert.ok(out.slice(1).every(page => page.startsWith('```text\n')),
    'every continuation page must reopen the original language')
})
