import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { gptCommand, runGptDoctor } from '../src/commands.ts'
import { readSessionStats } from '../src/codex-chat.ts'
import { appendRuntimeChecks, type DoctorCheck } from '../src/runtime-doctor.ts'

test('/gpt exposes session and doctor commands', () => {
  const names = new Set(gptCommand.toJSON().options?.map((option: any) => option.name))
  assert.ok(names.has('session'))
  assert.ok(names.has('doctor'))
})

test('session stats read current rollout turns, model, context, and cumulative usage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-session-stats-'))
  const id = 'session-test-id'
  const dir = path.join(root, '2026', '08', '03')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id } }),
    JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-test', effort: 'high' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'one' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'two' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: {
        input_tokens: 1200, cached_input_tokens: 500, output_tokens: 300,
        reasoning_output_tokens: 100, total_tokens: 1500,
      },
      last_token_usage: { input_tokens: 700 },
      model_context_window: 8000,
    } } }),
  ].join('\n'))

  const stats = await readSessionStats(id, root)
  assert.deepEqual(stats, {
    sessionId: id,
    turns: 2,
    model: 'gpt-test',
    effort: 'high',
    inputTokens: 1200,
    cachedInputTokens: 500,
    outputTokens: 300,
    reasoningTokens: 100,
    totalTokens: 1500,
    lastInputTokens: 700,
    contextWindow: 8000,
  })
})

test('doctor validates the runtime state without creating or mutating files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-doctor-'))
  const state = path.join(root, 'state')
  const rollouts = path.join(root, 'rollouts')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(rollouts, { recursive: true })
  fs.writeFileSync(path.join(state, 'access.json'), '{"version":2,"channels":{}}')
  fs.writeFileSync(path.join(state, 'persona.md'), 'you are gpt')
  const before = fs.readdirSync(state, { recursive: true }).sort()

  const report = await runGptDoctor(state, rollouts)

  assert.equal(report.ok, true)
  assert.deepEqual(report.checks.map(check => check.name), [
    'process', 'slash schema', 'state directory', 'access config',
    'persona', 'rollout store', 'agent registry',
  ])
  assert.deepEqual(fs.readdirSync(state, { recursive: true }).sort(), before)
})

test('doctor exposes global queue and memory-pressure admission state', async () => {
  const healthy: DoctorCheck[] = []
  await appendRuntimeChecks(healthy, {
    admission: () => ({ running: 2, queued: 3, oldestWaitMs: 12_300, pausedForMemory: false }),
  })
  assert.deepEqual(healthy, [{
    name: 'turn admission',
    ok: true,
    detail: '2 running · 3 queued · oldest 13s',
  }])

  const paused: DoctorCheck[] = []
  await appendRuntimeChecks(paused, {
    admission: () => ({ running: 1, queued: 4, oldestWaitMs: 20_000, pausedForMemory: true }),
  })
  assert.equal(paused[0].ok, false)
  assert.match(paused[0].detail, /MEMORY PAUSED/)
})
