import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  initLiveUsage, noteRoundtrip, clearTurn, liveSnapshot, _reset,
} from '../src/live-usage.ts'
import { rolloutOutputDelta } from '../src/codex-chat.ts'

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gpt-live-'))
  return path.join(dir, 'live-usage.json')
}

test('rolloutOutputDelta reads the per-roundtrip delta, not the running total', () => {
  // Real rollout shape: last_token_usage is this roundtrip, total is the session.
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { output_tokens: 233, input_tokens: 63824 },
        last_token_usage: { output_tokens: 61, input_tokens: 33720 },
      },
    },
  }
  assert.equal(rolloutOutputDelta(ev), 61)
})

test('rolloutOutputDelta ignores rows that are not token counts', () => {
  assert.equal(rolloutOutputDelta({ type: 'event_msg', payload: { type: 'agent_reasoning', text: 'x' } }), null)
  assert.equal(rolloutOutputDelta({ type: 'item.completed', item: { type: 'agent_message', text: 'x' } }), null)
  assert.equal(rolloutOutputDelta(null), null)
  assert.equal(rolloutOutputDelta({ type: 'event_msg', payload: { type: 'token_count' } }), null)
})

test('a turn accumulates its roundtrip deltas', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  for (const d of [172, 61, 117]) noteRoundtrip('thread-a', d)
  assert.equal(liveSnapshot().output, 350)
})

test('concurrent turns are counted separately and summed', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', 100)
  noteRoundtrip('thread-b', 40)
  noteRoundtrip('thread-a', 25)
  assert.equal(liveSnapshot().output, 165)
  clearTurn('thread-a')
  assert.equal(liveSnapshot().output, 40)
})

test('clearing a turn it never knew about is a no-op', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', 10)
  clearTurn('nobody')
  assert.equal(liveSnapshot().output, 10)
})

test('in-flight totals reach disk for the fleet sampler to read', async () => {
  _reset()
  const file = await tmpFile()
  initLiveUsage(file)
  noteRoundtrip('thread-a', 172)
  noteRoundtrip('thread-a', 61)
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(written.turns['thread-a'].output, 233)
  assert.ok(written.turns['thread-a'].ts > 0)
  // Clearing must land too, or a finished turn keeps inflating the needle.
  clearTurn('thread-a')
  const after = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(after.turns, {})
})

test('a zero or junk delta never moves the needle', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', 0)
  noteRoundtrip('thread-a', Number.NaN)
  noteRoundtrip('thread-a', -5)
  assert.equal(liveSnapshot().output, 0)
})

test('writing works before init and simply keeps no file', () => {
  _reset()
  noteRoundtrip('thread-a', 50)
  assert.equal(liveSnapshot().output, 50)
})
