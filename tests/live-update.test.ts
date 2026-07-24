import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveLiveEndLinger,
  resolveLiveUpdateInterval,
  shouldLingerLiveEnd,
} from '../src/live-update.ts'

test('live update interval keeps the original 1.5-second cadence', () => {
  assert.equal(resolveLiveUpdateInterval(undefined), 1500)
  assert.equal(resolveLiveUpdateInterval('8000'), 8000)
  assert.equal(resolveLiveUpdateInterval('nope'), 1500)
})

test('completed live state lingers for five seconds by default', () => {
  assert.equal(resolveLiveEndLinger(undefined), 5000)
  assert.equal(resolveLiveEndLinger('2500'), 2500)
  assert.equal(resolveLiveEndLinger('0'), 0)
  assert.equal(resolveLiveEndLinger('nope'), 5000)
})

test('end linger applies only when a normal turn rendered live state', () => {
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: true }), true)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: false, hasLiveState: false }), false)
  assert.equal(shouldLingerLiveEnd({ isRegeneration: true, hasLiveState: true }), false)
})
