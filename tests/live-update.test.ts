import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceLiveProgressDwell,
  liveProgressDwellMs,
  resolveLiveEndLinger,
  resolveLiveUpdateInterval,
  shouldLingerLiveEnd,
} from '../src/live-update.ts'

test('live update interval keeps the original 1.5-second cadence', () => {
  assert.equal(resolveLiveUpdateInterval(undefined), 1500)
  assert.equal(resolveLiveUpdateInterval('8000'), 8000)
  assert.equal(resolveLiveUpdateInterval('nope'), 1500)
})

test('completed live state lingers for fifteen seconds by default', () => {
  assert.equal(resolveLiveEndLinger(undefined), 15_000)
  assert.equal(resolveLiveEndLinger('2500'), 2500)
  assert.equal(resolveLiveEndLinger('0'), 0)
  assert.equal(resolveLiveEndLinger('nope'), 15_000)
})

test('end linger applies only when a normal turn rendered live state', () => {
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: true }), true)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: false }), false)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: true, hasLiveState: true }), false)
})

test('substantial progress gets paragraph-scale read time', () => {
  assert.equal(liveProgressDwellMs('short status'), 0)
  assert.equal(liveProgressDwellMs('first line\nsecond line'), 10_000)
  assert.equal(liveProgressDwellMs('word '.repeat(50)), 15_000)
  assert.equal(liveProgressDwellMs('word '.repeat(100)), 30_000)
  assert.equal(liveProgressDwellMs('x'.repeat(1000), 8000), 8000)
})

test('new substantial progress starts one reading dwell', () => {
  assert.deepEqual(
    advanceLiveProgressDwell({
      text: 'first line\nsecond line',
      lastText: '',
      renderedAt: 20_000,
      holdUntil: 0,
    }),
    {
      lastText: 'first line\nsecond line',
      holdUntil: 30_000,
    },
  )
})

test('spinner-only redraws do not perpetually renew the reading dwell', () => {
  assert.deepEqual(
    advanceLiveProgressDwell({
      text: 'first line\nsecond line',
      lastText: 'first line\nsecond line',
      renderedAt: 29_500,
      holdUntil: 30_000,
    }),
    {
      lastText: 'first line\nsecond line',
      holdUntil: 30_000,
    },
  )
})
