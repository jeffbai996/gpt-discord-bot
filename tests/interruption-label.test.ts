import assert from 'node:assert/strict'
import test from 'node:test'

import { RETRY_PROMPT } from '../src/interruption-label.ts'

test('retry prompt stays concise and punctuation-free', () => {
  assert.equal(RETRY_PROMPT, 'React 🔁 to retry')
})
