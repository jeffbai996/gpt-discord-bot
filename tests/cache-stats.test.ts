import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { initGlobalStats, pacificDay, recordTurn, snapshot, _reset } from '../src/cache-stats.ts'
import type { RespondResult } from '../src/openai.ts'

function makeResult(over: Partial<RespondResult['usage']> = {}, model = 'gpt-5.6-sol'): RespondResult {
  return {
    react: null,
    reply: '',
    usage: {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      ...over,
    },
    finishReason: 'stop',
    durationMs: 100,
    modelUsed: model,
    reasoning: '',
    toolCalls: [],
  }
}

test('cache-stats: empty channel returns zero snapshot', () => {
  _reset()
  const s = snapshot('ch1')
  assert.equal(s.turns, 0)
  assert.equal(s.cacheHitRate, 0)
  assert.equal(s.oldestTs, null)
})

test('cache-stats: records a turn and reports it', () => {
  _reset()
  recordTurn('ch1', makeResult({ cachedInputTokens: 800 }))
  const s = snapshot('ch1')
  assert.equal(s.turns, 1)
  assert.equal(s.inputTokens, 1000)
  assert.equal(s.cachedInputTokens, 800)
  assert.equal(s.cacheHitRate, 0.8)
  assert.deepEqual(s.models, ['gpt-5.6-sol'])
})

test('cache-stats: accumulates across turns', () => {
  _reset()
  recordTurn('ch1', makeResult({ inputTokens: 1000, cachedInputTokens: 500 }))
  recordTurn('ch1', makeResult({ inputTokens: 2000, cachedInputTokens: 1500 }))
  const s = snapshot('ch1')
  assert.equal(s.turns, 2)
  assert.equal(s.inputTokens, 3000)
  assert.equal(s.cachedInputTokens, 2000)
  assert.equal(s.cacheHitRate, 2000 / 3000)
})

test('cache-stats: ring-buffer caps at 50 turns', () => {
  _reset()
  for (let i = 0; i < 75; i++) {
    recordTurn('ch1', makeResult({ inputTokens: 100 }))
  }
  const s = snapshot('ch1')
  assert.equal(s.turns, 50)
  assert.equal(s.inputTokens, 5000)
})

test('cache-stats: channels are isolated', () => {
  _reset()
  recordTurn('ch1', makeResult({ inputTokens: 100 }))
  recordTurn('ch2', makeResult({ inputTokens: 999 }))
  assert.equal(snapshot('ch1').inputTokens, 100)
  assert.equal(snapshot('ch2').inputTokens, 999)
})

test('cache-stats: tracks distinct models in window', () => {
  _reset()
  recordTurn('ch1', makeResult({}, 'gpt-5.6-sol'))
  recordTurn('ch1', makeResult({}, 'gpt-5.6-terra'))
  recordTurn('ch1', makeResult({}, 'gpt-5.6-sol'))
  const s = snapshot('ch1')
  assert.equal(s.models.length, 2)
  assert.ok(s.models.includes('gpt-5.6-sol'))
  assert.ok(s.models.includes('gpt-5.6-terra'))
})

test('cache-stats: ignores turns with no usage', () => {
  _reset()
  recordTurn('ch1', {
    react: null,
    reply: '',
    usage: null,
    finishReason: 'stop',
    durationMs: 1,
    modelUsed: 'gpt-5.6-sol',
    reasoning: '',
    toolCalls: [],
  })
  assert.equal(snapshot('ch1').turns, 0)
})

test('cache-stats: cacheHitRate is 0 when input is 0', () => {
  _reset()
  recordTurn('ch1', makeResult({ inputTokens: 0, cachedInputTokens: 0 }))
  assert.equal(snapshot('ch1').cacheHitRate, 0)
})

test('cache-stats: persists per-model usage in a Pacific-day bucket', async () => {
  _reset()
  const file = path.join(os.tmpdir(), `gpt-stats-${process.pid}-${Date.now()}.json`)
  initGlobalStats(file)
  recordTurn('ch1', makeResult({ inputTokens: 1200, outputTokens: 300, cachedInputTokens: 900 }, 'codex'))

  const saved = JSON.parse(await readFile(file, 'utf8'))
  const today = saved.days[pacificDay()]
  assert.equal(today.turns, 1)
  assert.equal(today.inputTokens, 1200)
  assert.equal(today.cachedInputTokens, 900)
  assert.deepEqual(today.byModel.codex, {
    turns: 1,
    inputTokens: 1200,
    outputTokens: 300,
    cachedInputTokens: 900,
    reasoningTokens: 0,
  })
  _reset()
})
