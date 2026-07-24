import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveLiveEndLinger,
  resolveLiveUpdateInterval,
} from '../src/live-update.ts'

test('live update interval defaults to chunky five-second updates', () => {
  assert.equal(resolveLiveUpdateInterval(undefined), 5000)
  assert.equal(resolveLiveUpdateInterval('8000'), 8000)
  assert.equal(resolveLiveUpdateInterval('nope'), 5000)
})

test('completed live state lingers for five seconds by default', () => {
  assert.equal(resolveLiveEndLinger(undefined), 5000)
  assert.equal(resolveLiveEndLinger('2500'), 2500)
  assert.equal(resolveLiveEndLinger('0'), 0)
  assert.equal(resolveLiveEndLinger('nope'), 5000)
})
