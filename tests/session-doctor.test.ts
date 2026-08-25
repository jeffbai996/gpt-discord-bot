import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { gptCommand, runGptDoctor } from '../src/commands.ts'
import { readSessionStats } from '../src/codex-chat.ts'

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

test('doctor reports background model, memory, deployment, and slash-command health', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-doctor-runtime-'))
  const state = path.join(root, 'state')
  const rollouts = path.join(root, 'rollouts')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(rollouts, { recursive: true })
  fs.writeFileSync(path.join(state, 'access.json'), '{"version":2,"channels":{}}')
  fs.writeFileSync(path.join(state, 'persona.md'), 'you are gpt')
  const now = Date.parse('2026-08-25T16:00:00Z')
  const expectedCommand = gptCommand.toJSON()

  const report = await runGptDoctor(state, rollouts, {
    now: () => now,
    memory: {
      messageCount: 120,
      latestMessageAt: '2026-08-25T15:58:00Z',
      summaryCount: 4,
      latestSummaryAt: '2026-08-25T15:30:00Z',
      maxPendingMessages: 12,
      summarizationThreshold: 50,
    },
    backgroundModels: {
      summarizerModel: 'model-summary',
      embeddingModel: 'model-embed',
      list: async () => ['model-summary', 'model-embed'],
    },
    deployment: {
      boot: { revision: 'abc12345', fingerprint: 'clean' },
      current: async () => ({ revision: 'abc12345', fingerprint: 'clean' }),
    },
    slashCommands: {
      expected: expectedCommand,
      fetchRemote: async () => [{ ...expectedCommand, type: 1, id: 'remote-id', version: 'remote-version' }],
    },
  })

  assert.equal(report.ok, true)
  assert.deepEqual(report.checks.slice(-7).map(check => check.name), [
    'memory ingestion', 'summary state', 'model endpoint', 'summary model',
    'embedding model', 'deployed source', 'remote slash',
  ])
})

test('doctor fails loudly on the stale brain states that used to pass', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-doctor-failures-'))
  const state = path.join(root, 'state')
  const rollouts = path.join(root, 'rollouts')
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(rollouts, { recursive: true })
  fs.writeFileSync(path.join(state, 'access.json'), '{"version":2,"channels":{}}')
  fs.writeFileSync(path.join(state, 'persona.md'), 'you are gpt')
  const expectedCommand = gptCommand.toJSON()

  const report = await runGptDoctor(state, rollouts, {
    now: () => Date.parse('2026-08-25T16:00:00Z'),
    memory: {
      messageCount: 120,
      latestMessageAt: '2026-08-20T12:00:00Z',
      summaryCount: 1,
      latestSummaryAt: '2026-08-14T12:00:00Z',
      maxPendingMessages: 80,
      summarizationThreshold: 50,
    },
    backgroundModels: {
      summarizerModel: 'missing-summary-model',
      embeddingModel: 'model-embed',
      list: async () => ['model-embed'],
    },
    deployment: {
      boot: { revision: 'abc12345', fingerprint: 'clean' },
      current: async () => ({ revision: 'def67890', fingerprint: 'dirty:1234' }),
    },
    slashCommands: {
      expected: expectedCommand,
      fetchRemote: async () => [{ ...expectedCommand, description: 'stale schema' }],
    },
  })

  assert.equal(report.ok, false)
  for (const name of ['memory ingestion', 'summary state', 'summary model', 'deployed source', 'remote slash']) {
    assert.equal(report.checks.find(check => check.name === name)?.ok, false, name)
  }
})
