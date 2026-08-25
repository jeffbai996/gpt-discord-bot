import assert from 'node:assert/strict'
import test from 'node:test'

import { preserveAndDropSession } from '../src/session-rollover.ts'

test('rollover drops the session only after a durable summary is written', async () => {
  const events: string[] = []
  const result = await preserveAndDropSession({
    summarizer: {
      runForChannel: async channelId => {
        events.push(`summarize:${channelId}`)
        return { messageCount: 4 }
      },
    },
    channelId: 'channel-1',
    dropSession: channelId => {
      events.push(`drop:${channelId}`)
      return true
    },
    timeoutMs: 1_000,
  })

  assert.deepEqual(result, { status: 'compacted', messageCount: 4, droppedSession: true })
  assert.deepEqual(events, ['summarize:channel-1', 'drop:channel-1'])
})

test('rollover preserves the session when summarization fails', async () => {
  let dropped = false
  const result = await preserveAndDropSession({
    summarizer: { runForChannel: async () => { throw new Error('model unavailable') } },
    channelId: 'channel-1',
    dropSession: () => { dropped = true; return true },
    timeoutMs: 1_000,
  })

  assert.equal(result.status, 'failed')
  assert.equal(dropped, false)
})

test('rollover preserves the session on timeout or absent summary output', async () => {
  for (const summarizer of [
    { runForChannel: async () => new Promise<never>(() => {}) },
    { runForChannel: async () => null },
    null,
  ]) {
    let dropped = false
    const result = await preserveAndDropSession({
      summarizer,
      channelId: 'channel-1',
      dropSession: () => { dropped = true; return true },
      timeoutMs: 5,
    })
    assert.notEqual(result.status, 'compacted')
    assert.equal(dropped, false)
  }
})
