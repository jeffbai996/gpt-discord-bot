import assert from 'node:assert/strict'
import test from 'node:test'

import { buildCompletionReceipt } from '../src/completion-receipt.ts'
import type { ToolCall } from '../src/openai.ts'

const call = (name: string, command: string, resultPreview = '', failed = false): ToolCall => ({
  name,
  args: name === 'edit' ? { file_path: command } : { command },
  durationMs: 0,
  resultPreview,
  failed,
})

test('completion receipt summarizes observed coding outcomes behind a spoiler', () => {
  const receipt = buildCompletionReceipt([
    call('edit', 'src/app.ts'),
    call('edit', 'tests/app.test.ts'),
    call('shell', 'npm test', '# pass 379\n# skipped 1'),
    call('shell', "git commit -m 'fix: app'", '[main 0495506] fix: app'),
    call('shell', 'git push origin main && systemctl --user kill -s SIGUSR2 app'),
  ])
  assert.equal(receipt?.text, '-# ▸ work receipt · ||2 files changed · 379 tests passed / 1 skipped · commit 0495506 · deployed||')
})

test('completion receipt ignores failed or non-coding tool activity', () => {
  assert.equal(buildCompletionReceipt([
    call('web_search', '', 'results'),
    call('shell', 'npm test', '1 failed', true),
  ]), null)
})
