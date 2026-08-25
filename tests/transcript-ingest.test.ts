import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cleanBotTranscriptContent,
  persistTranscriptMessage,
} from '../src/transcript-ingest.ts'

const row = {
  id: '123',
  channel_id: 'channel',
  author_id: 'bot',
  author_name: 'gpt',
  content: 'final answer',
  timestamp: '2026-08-25T20:00:00.000Z',
}

test('stores clean transcript text even when embedding fails', async () => {
  const stored: typeof row[] = []
  const embedded: Array<[string, number[]]> = []
  const result = await persistTranscriptMessage({
    store: {
      insertMessageText: message => { stored.push(message) },
      insertMessageEmbedding: (id, vector) => { embedded.push([id, vector]) },
    },
    row,
    shouldEmbed: true,
    embed: async () => null,
  })

  assert.deepEqual(stored, [row])
  assert.deepEqual(embedded, [])
  assert.deepEqual(result, { stored: true, embedded: false })
})

test('attaches an embedding after the durable transcript row exists', async () => {
  const events: string[] = []
  const result = await persistTranscriptMessage({
    store: {
      insertMessageText: () => { events.push('stored') },
      insertMessageEmbedding: () => { events.push('embedded') },
    },
    row,
    shouldEmbed: true,
    embed: async () => {
      events.push('embed requested')
      return [0.1, 0.2]
    },
  })

  assert.deepEqual(events, ['stored', 'embed requested', 'embedded'])
  assert.deepEqual(result, { stored: true, embedded: true })
})

test('bot transcript cleanup keeps the answer and removes trace and transient thought UI', () => {
  const raw = [
    '💭 ✓ **thought for 9s**',
    '> 🧠 internal progress recap',
    'The actual answer survives.',
    '-# ↑ 1,234 · ↓ 56 · ◷ 9s',
  ].join('\n')
  assert.equal(cleanBotTranscriptContent(raw), 'The actual answer survives.')
  assert.equal(cleanBotTranscriptContent('🔧 **Tool trace**\n```diff\n+ ● shell(foo)\n```'), '')
})
