import assert from 'node:assert/strict'
import test from 'node:test'

import { formatLiveWorkMessage } from '../src/live-ui.ts'

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
      footer: '-# ✻ still working · 30s elapsed · last activity 4s ago',
    }),
    '💭 ✻ **thinking…**\n\n-# ✻ still working · 30s elapsed · last activity 4s ago',
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
    footer: '-# still working',
    maxLength: 50,
  })

  assert.equal(message.length, 50)
  assert.match(message, /^💭 ✻ \*\*thinking…\*\*/)
  assert.match(message, /…\n\n-# still working$/)
})
