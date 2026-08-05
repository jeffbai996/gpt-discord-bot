import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  initLiveUsage, noteRoundtrip, clearTurn, beginTurn, liveSnapshot, _reset,
} from '../src/live-usage.ts'
import { rolloutOutputDelta, rolloutUsageDelta } from '../src/codex-chat.ts'

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

test('rolloutUsageDelta preserves every billable token class', () => {
  const ev = {
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: 999_999, output_tokens: 99_999 },
        last_token_usage: {
          input_tokens: 34_128,
          cached_input_tokens: 29_440,
          output_tokens: 355,
          reasoning_output_tokens: 123,
        },
      },
    },
  }
  assert.deepEqual(rolloutUsageDelta(ev), {
    input: 34_128,
    cachedInput: 29_440,
    output: 355,
    reasoning: 123,
  })
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

test('concurrent turns retain full usage and model for live pricing', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', {
    input: 10_000, cachedInput: 8_000, output: 300, reasoning: 120,
  }, 'gpt-5.6-sol high')
  noteRoundtrip('thread-b', {
    input: 20_000, cachedInput: 15_000, output: 500, reasoning: 300,
  }, 'gpt-5.6-sol low')
  noteRoundtrip('thread-a', {
    input: 5_000, cachedInput: 4_000, output: 200, reasoning: 80,
  }, 'gpt-5.6-sol high')

  assert.deepEqual(liveSnapshot(), {
    input: 35_000,
    cachedInput: 27_000,
    output: 1_000,
    reasoning: 500,
    turns: 2,
  })
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

test('full in-flight usage reaches disk for dollar accounting', async () => {
  _reset()
  const file = await tmpFile()
  initLiveUsage(file)
  noteRoundtrip('thread-a', {
    input: 34_128, cachedInput: 29_440, output: 355, reasoning: 123,
  }, 'gpt-5.6-sol medium')
  const written = JSON.parse(await readFile(file, 'utf8'))
  assert.deepEqual(written.turns['thread-a'], {
    input: 34_128,
    cachedInput: 29_440,
    output: 355,
    reasoning: 123,
    model: 'gpt-5.6-sol medium',
    ts: written.turns['thread-a'].ts,
  })
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

test('a new turn starts from zero even if the last one died mid-flight', async () => {
  // A turn that errors never reaches recordTurn, so nothing clears it. The
  // next turn on that thread must not inherit the corpse and read double.
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', 900)   // previous turn, killed
  beginTurn('thread-a')
  noteRoundtrip('thread-a', 50)
  assert.equal(liveSnapshot().output, 50)
})

test('beginTurn leaves other threads alone', async () => {
  _reset()
  initLiveUsage(await tmpFile())
  noteRoundtrip('thread-a', 900)
  noteRoundtrip('thread-b', 30)
  beginTurn('thread-a')
  assert.equal(liveSnapshot().output, 30)
})

test('replaying a turn roundtrip-by-roundtrip lands on codex own total', async () => {
  // The invariant the whole design rests on: the per-roundtrip deltas sum to
  // the session total codex reports at the end. Shape and numbers are lifted
  // from a real rollout. If codex ever redefines last_token_usage, the live
  // needle would start disagreeing with the billed total — this catches it.
  const roundtrips = [
    { total: 172, last: 172 },
    { total: 233, last: 61 },
    { total: 350, last: 117 },
    { total: 625, last: 275 },
  ]
  _reset()
  initLiveUsage(await tmpFile())
  for (const r of roundtrips) {
    const delta = rolloutOutputDelta({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { output_tokens: r.total },
          last_token_usage: { output_tokens: r.last },
        },
      },
    })
    assert.notEqual(delta, null)
    noteRoundtrip('thread-a', delta!)
  }
  assert.equal(liveSnapshot().output, roundtrips.at(-1)!.total)
})
