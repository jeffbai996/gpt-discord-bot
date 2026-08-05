import assert from 'node:assert/strict'
import test from 'node:test'

import { extractRichMedia, formatRichContext } from '../src/discord-rich-input.ts'

test('recovers a fresh Discord GIF proxy instead of the expired body URL', () => {
  const media = extractRichMedia({
    content: 'https://cdn.discordapp.com/attachments/old/duckyo.gif',
    embeds: [{
      thumbnail: {
        url: 'https://cdn.discordapp.com/attachments/old/duckyo.gif?expired',
        proxyURL: 'https://media.discordapp.net/attachments/old/duckyo.gif?fresh',
        contentType: 'image/gif',
      },
    }],
  })
  assert.deepEqual(media, [{
    name: 'embed-1.gif',
    url: 'https://media.discordapp.net/attachments/old/duckyo.gif?fresh',
    size: 0,
    contentType: 'image/gif',
  }])
})

test('turns native stickers into visual media and semantic context', () => {
  const message = {
    stickers: [{ id: '123', name: 'duckyo_buy', format: 4, url: 'https://cdn.discordapp.com/stickers/123.gif' }],
  }
  assert.equal(extractRichMedia(message)[0]?.contentType, 'image/gif')
  assert.match(formatRichContext(message), /duckyo_buy/)
})

test('hydrates forwarded snapshots without inventing an author', () => {
  const message = {
    messageSnapshots: [{
      content: 'forwarded thought',
      attachments: [{ name: 'chart.png', url: 'https://example.invalid/chart.png', size: 42, contentType: 'image/png' }],
      embeds: [], stickers: [],
    }],
  }
  assert.equal(extractRichMedia(message)[0]?.name, 'chart.png')
  const context = formatRichContext(message)
  assert.match(context, /original author is unavailable/)
  assert.match(context, /forwarded thought/)
})

test('renders polls with emoji, vote counts, and multiselect state', () => {
  const text = formatRichContext({
    poll: {
      question: { text: 'Dinner?' },
      answers: [
        { id: 1, text: 'Sushi', emoji: { name: '🍣' }, voteCount: 2 },
        { id: 2, text: 'Tacos', emoji: { name: '🌮' }, voteCount: 3 },
      ],
      allowMultiselect: false,
      expiresTimestamp: Date.UTC(2026, 7, 6),
      resultsFinalized: false,
    },
  })
  assert.match(text, /Dinner\?/)
  assert.match(text, /🍣/)
  assert.match(text, /"votes":3/)
  assert.match(text, /"allow_multiselect":false/)
})

test('uses gifv video so the animation pipeline can sample motion', () => {
  const media = extractRichMedia({
    embeds: [{
      provider: { name: 'Tenor' },
      video: { url: 'https://media.tenor.com/example.mp4' },
      thumbnail: { url: 'https://media.tenor.com/example.png' },
    }],
  })
  assert.equal(media[0]?.contentType, 'video/mp4')
  assert.equal(media[0]?.name, 'embed-1.mp4')
})
