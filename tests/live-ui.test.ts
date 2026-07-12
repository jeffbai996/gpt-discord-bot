import assert from 'node:assert/strict'
import test from 'node:test'

import { formatHeartbeatFooter, formatLiveWorkMessage } from '../src/live-ui.ts'

test('renders heartbeat status in a Discord code block', () => {
  assert.equal(
    formatHeartbeatFooter(33_000, 4_000),
    '```\n✻ still working · 33s elapsed · last activity 4s ago\n```',
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
      footer: '```\n✻ still working · 30s elapsed · last activity 4s ago\n```',
    }),
    '💭 ✻ **thinking…**\n\n```\n✻ still working · 30s elapsed · last activity 4s ago\n```',
  )
})

test('keeps commentary outside the heartbeat code block', () => {
  assert.equal(
    formatLiveWorkMessage({
      effortLabel: 'thinking',
      detail: 'Checking the actual repos.',
      footer: '```\n✻ still working · 33s elapsed · last activity 4s ago\n```',
    }),
    '💭 ✻ **thinking…**\nChecking the actual repos.\n\n```\n✻ still working · 33s elapsed · last activity 4s ago\n```',
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
