import assert from 'node:assert/strict'
import test from 'node:test'

import { closeDanglingInlineCode } from '../src/discord-markdown.ts'

test('closes dangling inline code before it consumes following lines', () => {
  const input = '- gpt: `abc123` — `353 passed\n- Gemma: `def456` — clean'

  assert.equal(
    closeDanglingInlineCode(input),
    '- gpt: `abc123` — `353 passed`\n- Gemma: `def456` — clean',
  )
})

test('leaves balanced inline code and fenced code blocks unchanged', () => {
  const input = 'commit `abc123`\n```ts\nconst value = `template`\n```'

  assert.equal(closeDanglingInlineCode(input), input)
})
