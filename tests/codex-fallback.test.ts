import assert from 'node:assert/strict'
import test from 'node:test'

import { codexFallbackWaitMs } from '../src/codex-fallback.ts'
import { CodexInterruptedError, CodexProcessDiedError } from '../src/codex-chat.ts'

test('waits out the fallback grace period after a confirmed codex death', () => {
  assert.equal(codexFallbackWaitMs(new CodexProcessDiedError(12_000, 'exit 1'), 90_000), 78_000)
  assert.equal(codexFallbackWaitMs(new CodexInterruptedError(120_000), 90_000), 0)
})

test('does not API-fallback for errors that do not confirm codex terminated', () => {
  assert.equal(codexFallbackWaitMs(new Error('output parse failed'), 90_000), null)
})
