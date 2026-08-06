import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { RETRY_PROMPT } from '../src/interruption-label.ts'

test('retry prompt stays concise and punctuation-free', () => {
  assert.equal(RETRY_PROMPT, 'React 🔁 to retry')
})

test('hard stop has exactly one interruption renderer', () => {
  const source = fs.readFileSync(new URL('../src/gpt.ts', import.meta.url), 'utf8')
  const hardStop = source.slice(
    source.indexOf('if (isHardStopMessage(message.content)) {'),
    source.indexOf('// Barge-in', source.indexOf('if (isHardStopMessage(message.content)) {')),
  )

  assert.doesNotMatch(hardStop, /send\?\.\(`\$\{INTERRUPTED_MARKER\}/)
  assert.match(source, /const renderInterruptedTurn = async \(\) =>/)
  assert.equal((source.match(/await renderInterruptedTurn\(\)/g) ?? []).length, 2)
})
