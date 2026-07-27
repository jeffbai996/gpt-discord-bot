import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
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

test('completed live state lingers for ten seconds by default', () => {
  assert.equal(resolveLiveEndLinger(undefined), 10_000)
  assert.equal(resolveLiveEndLinger('2500'), 2500)
  assert.equal(resolveLiveEndLinger('0'), 0)
  assert.equal(resolveLiveEndLinger('nope'), 10_000)
})

test('end linger applies only when a normal turn rendered live state', () => {
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: true }), true)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: false }), false)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: true, hasLiveState: true }), false)
})

test('substantial progress gets up to fifteen seconds of read time', () => {
  assert.equal(liveProgressDwellMs('short status'), 0)
  assert.equal(liveProgressDwellMs('first line\nsecond line'), 4000)
  assert.equal(liveProgressDwellMs('x'.repeat(300)), 6000)
  assert.equal(liveProgressDwellMs('x'.repeat(1000)), 15000)
  assert.equal(liveProgressDwellMs('x'.repeat(1000), 8000), 8000)
})
