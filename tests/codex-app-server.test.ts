import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { CodexAppServerClient } from '../src/codex-app-server.ts'
import {
  compactionLifecycleEvent,
  normalizeAppServerNotification,
  parseCodexEvents,
} from '../src/codex-chat.ts'

test('sends guarded turn steering and resolves the matching response', async () => {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const client = new CodexAppServerClient(fromServer, toServer)
  const lines: any[] = []
  toServer.on('data', chunk => {
    for (const line of String(chunk).trim().split('\n')) lines.push(JSON.parse(line))
  })

  const steering = client.steer('thread-1', 'turn-1', 'also verify the live service')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(lines[0], {
    id: 1,
    method: 'turn/steer',
    params: {
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'also verify the live service' }],
    },
  })
  fromServer.write(`${JSON.stringify({ id: 1, result: { turnId: 'turn-1' } })}\n`)
  assert.equal(await steering, true)
  client.close()
})

test('reports an unavailable steer without killing the protocol client', async () => {
  const toServer = new PassThrough()
  const fromServer = new PassThrough()
  const client = new CodexAppServerClient(fromServer, toServer)
  const steering = client.steer('thread-1', 'turn-1', 'follow-up')
  await new Promise(resolve => setImmediate(resolve))
  fromServer.write(`${JSON.stringify({
    id: 1,
    error: { code: -32000, message: 'active turn is not steerable' },
  })}\n`)
  assert.equal(await steering, false)
  client.close()
})

test('preserves final-answer phase and per-turn token usage from app-server events', () => {
  assert.deepEqual(normalizeAppServerNotification({
    method: 'item/completed',
    params: { item: { type: 'agentMessage', text: 'done', phase: 'final_answer' } },
  }), {
    type: 'item.completed',
    item: { type: 'agent_message', text: 'done', phase: 'final_answer' },
  })
  assert.deepEqual(normalizeAppServerNotification({
    method: 'thread/tokenUsage/updated',
    params: { tokenUsage: { last: {
      inputTokens: 10, cachedInputTokens: 7, outputTokens: 3, reasoningOutputTokens: 2,
    } } },
  })?.usage, {
    input_tokens: 10,
    cached_input_tokens: 7,
    output_tokens: 3,
    reasoning_output_tokens: 2,
  })
})

test('preserves native context-compaction boundaries for the Discord live UI', () => {
  const started = normalizeAppServerNotification({
    method: 'item/started',
    params: { item: { type: 'contextCompaction', id: 'compact-1' } },
  })
  const completed = normalizeAppServerNotification({
    method: 'item/completed',
    params: { item: { type: 'contextCompaction', id: 'compact-1' } },
  })
  const legacyCompleted = normalizeAppServerNotification({
    method: 'thread/compacted',
    params: { threadId: 'thread-1', turnId: 'turn-1' },
  })

  assert.deepEqual(started, {
    type: 'item.started',
    item: { type: 'context_compaction', id: 'compact-1' },
  })
  assert.deepEqual(completed, {
    type: 'item.completed',
    item: { type: 'context_compaction', id: 'compact-1' },
  })
  assert.deepEqual(legacyCompleted, { type: 'thread.compacted' })
  assert.deepEqual(compactionLifecycleEvent(started), { type: 'compaction', active: true })
  assert.deepEqual(compactionLifecycleEvent(completed), { type: 'compaction', active: false })
  assert.deepEqual(compactionLifecycleEvent(legacyCompleted), { type: 'compaction', active: false })
  assert.equal(compactionLifecycleEvent({ type: 'turn.started' }), null)
})

test('aggregates every app-server roundtrip into completed-turn usage', () => {
  const lines = [
    {
      type: 'usage.updated',
      usage: {
        input_tokens: 100_000,
        cached_input_tokens: 90_000,
        output_tokens: 2_000,
        reasoning_output_tokens: 800,
      },
    },
    {
      type: 'usage.updated',
      usage: {
        input_tokens: 120_000,
        cached_input_tokens: 110_000,
        output_tokens: 3_000,
        reasoning_output_tokens: 1_200,
      },
    },
    { type: 'turn.completed' },
  ].map(line => JSON.stringify(line)).join('\n')

  const parsed = parseCodexEvents(lines)
  assert.deepEqual(parsed.usage, {
    inputTokens: 220_000,
    cachedInputTokens: 200_000,
    outputTokens: 5_000,
    reasoningTokens: 2_000,
    totalTokens: 225_000,
  })
  assert.equal(parsed.usageIsCumulative, false)
})

test('keeps legacy turn-completed usage cumulative instead of summing snapshots', () => {
  const lines = [
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 220_000,
        cached_input_tokens: 200_000,
        output_tokens: 5_000,
        reasoning_output_tokens: 2_000,
      },
    },
  ].map(line => JSON.stringify(line)).join('\n')

  const parsed = parseCodexEvents(lines)
  assert.equal(parsed.usage?.inputTokens, 220_000)
  assert.equal(parsed.usageIsCumulative, true)
})
