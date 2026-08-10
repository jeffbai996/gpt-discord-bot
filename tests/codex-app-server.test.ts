import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { CodexAppServerClient } from '../src/codex-app-server.ts'
import { normalizeAppServerNotification } from '../src/codex-chat.ts'

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
