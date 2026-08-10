import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MAX_MISSED_FRAMES,
  resolveMaxMissedFrames,
} from '../src/voice/playback.ts'

test('realtime playback tolerates five seconds of temporary stream starvation by default', () => {
  assert.equal(DEFAULT_MAX_MISSED_FRAMES, 250)
  assert.equal(resolveMaxMissedFrames(undefined), 250)
})

test('realtime playback accepts a positive max-missed-frames override', () => {
  assert.equal(resolveMaxMissedFrames('400'), 400)
})

test('realtime playback rejects invalid max-missed-frames overrides', () => {
  assert.equal(resolveMaxMissedFrames('0'), 250)
  assert.equal(resolveMaxMissedFrames('-5'), 250)
  assert.equal(resolveMaxMissedFrames('potato'), 250)
})
