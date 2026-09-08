import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildCodexFailurePostmortemRequest,
  codexFallbackWaitMs,
} from '../src/codex-fallback.ts'
import { CodexInterruptedError, CodexProcessDiedError } from '../src/codex-chat.ts'

test('waits out the fallback grace period after a confirmed codex death', () => {
  assert.equal(codexFallbackWaitMs(new CodexProcessDiedError(12_000, 'exit 1'), 90_000), 78_000)
  assert.equal(codexFallbackWaitMs(new CodexInterruptedError(120_000), 90_000), 0)
})

test('does not API-fallback for errors that do not confirm codex terminated', () => {
  assert.equal(codexFallbackWaitMs(new Error('output parse failed'), 90_000), null)
})

test('confirmed timeout builds a postmortem-only API request without tools or attachments', () => {
  const request = buildCodexFailurePostmortemRequest({
    base: {
      systemPrompt: 'normal agent prompt with implementation authority',
      history: [{ role: 'assistant', content: 'Earlier context' }],
      userMessage: 'edit the repository and deploy it',
      userName: 'alice',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      imageParts: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc' } }],
      extraText: 'local attachment contents',
      toolRegistry: {} as never,
      channelId: 'channel-1',
      userId: 'user-1',
    },
    error: new CodexInterruptedError(1_800_000, 'idle'),
    lastProgress: 'running the full test suite',
    recentTools: ['edit', 'exec_command'],
  })

  assert.match(request.systemPrompt, /postmortem/i)
  assert.match(request.systemPrompt, /Do not continue, retry, or complete/i)
  assert.match(request.systemPrompt, /Do not claim/i)
  assert.match(request.userMessage, /idle_timeout/)
  assert.match(request.userMessage, /idle watchdog/)
  assert.match(request.userMessage, /1800000/)
  assert.match(request.userMessage, /running the full test suite/)
  assert.match(request.userMessage, /edit the repository and deploy it/)
  assert.equal('toolRegistry' in request, false)
  assert.equal('imageParts' in request, false)
  assert.equal('extraText' in request, false)
  assert.deepEqual(request.history, [{ role: 'assistant', content: 'Earlier context' }])
})

test('confirmed process death is reported as a process failure, not task completion', () => {
  const request = buildCodexFailurePostmortemRequest({
    base: {
      systemPrompt: 'normal prompt',
      history: [],
      userMessage: 'do the work',
      userName: 'alice',
      model: 'gpt-5.6-sol',
    },
    error: new CodexProcessDiedError(42_000, 'codex exited code=1 signal=none'),
  })

  assert.match(request.userMessage, /process_died/)
  assert.match(request.userMessage, /codex exited code=1 signal=none/)
  assert.match(request.systemPrompt, /The original task remains unfinished/i)
})
