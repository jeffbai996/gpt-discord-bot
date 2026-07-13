import assert from 'node:assert/strict'
import test from 'node:test'

import { formatHeartbeatFooter, formatLiveWorkMessage, pickHeartbeatVerb } from '../src/live-ui.ts'

test('picks one heartbeat verb from the compact status pool', () => {
  assert.equal(pickHeartbeatVerb(() => 0), 'cogitating')
  assert.equal(pickHeartbeatVerb(() => 0.999), 'scheming')
})

test('renders heartbeat status as one compact inline row with one-cell side padding', () => {
  assert.equal(
    formatHeartbeatFooter(33_000, 4_000, 'cogitating'),
    '` ✻ cogitating · 33s · active 4s ago `',
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
