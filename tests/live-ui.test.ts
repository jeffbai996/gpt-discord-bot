import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatHeartbeatFooter,
  formatLiveWorkMessage,
  heartbeatVisual,
  nextHeartbeatVerb,
  pickHeartbeatGlyph,
  pickHeartbeatVerb,
  shouldRenderHeartbeat,
} from '../src/live-ui.ts'

test('picks one heartbeat verb from the compact status pool', () => {
  assert.equal(pickHeartbeatVerb(() => 0), 'cogitating')
  assert.equal(pickHeartbeatVerb(() => 0.999), 'scheming')
})

test('advances heartbeat verbs without repeating and wraps the pool', () => {
  assert.equal(nextHeartbeatVerb('cogitating'), 'pondering')
  assert.equal(nextHeartbeatVerb('scheming'), 'cogitating')
})

test('cycles the heartbeat glyph animation by frame', () => {
  assert.equal(pickHeartbeatGlyph(0), '✻')
  assert.equal(pickHeartbeatGlyph(1), '✢')
  assert.equal(pickHeartbeatGlyph(6), '✻')
})

test('keeps the verb stable for four frames before advancing it', () => {
  assert.deepEqual(heartbeatVisual(3, 'cogitating'), { glyph: '✶', verb: 'cogitating' })
  assert.deepEqual(heartbeatVisual(4, 'cogitating'), { glyph: '✷', verb: 'pondering' })
})

test('delays the heartbeat row until actual activity has been idle for 60 seconds', () => {
  assert.equal(shouldRenderHeartbeat(120_000, 59_999, 60_000), false)
  assert.equal(shouldRenderHeartbeat(120_000, 60_000, 60_000), true)
})

test('turn age alone never triggers a heartbeat during active work', () => {
  assert.equal(shouldRenderHeartbeat(600_000, 5_000, 60_000), false)
})

test('renders heartbeat status as one compact inline row with one-cell side padding', () => {
  assert.equal(
    formatHeartbeatFooter(33_000, 4_000, 'cogitating', '✶'),
    '` ✶ still cogitating · 33s · active 4s ago `',
  )
})

test('keeps the thinking header above live progress', () => {
  assert.equal(
    formatLiveWorkMessage({ effortLabel: 'thinking with max effort', detail: 'Checking the renderer.' }),
    '💭 ✻ **thinking with max effort…**\nChecking the renderer.',
  )
})

test('keeps the thinking header when only a heartbeat is available', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking',
      footer: '`✻ cogitating · 30s · active 4s ago`',
    }),
    '💭 ✻ **thinking…**\n\n`✻ cogitating · 30s · active 4s ago`',
  )
})

test('keeps commentary above the compact heartbeat row', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking',
      detail: 'Checking the actual repos.',
      footer: '`✻ cogitating · 33s · active 4s ago`',
    }),
    '💭 ✻ **thinking…**\nChecking the actual repos.\n\n`✻ cogitating · 33s · active 4s ago`',
  )
})

test('renders multiline commentary without blockquote markers', () => {
  const message = formatLiveWorkMessage({
    effortLabel: 'thinking',
    detail: 'A first line\nand a second line',
  })

  assert.match(message, /\nA first line\nand a second line/)
  assert.doesNotMatch(message, /^> /m)
})

test('clips progress before the footer instead of dropping the heartbeat', () => {
  const message = formatLiveWorkMessage({
    effortLabel: 'thinking',
    detail: 'abcdefghijklmnopqrstuvwxyz',
    footer: '```\nstill working\n```',
    maxLength: 58,
  })

  assert.equal(message.length, 58)
  assert.match(message, /^💭 ✻ \*\*thinking…\*\*/)
  assert.match(message, /…\n\n```\nstill working\n```$/)
})
