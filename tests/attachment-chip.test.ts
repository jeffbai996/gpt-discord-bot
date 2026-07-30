import assert from 'node:assert/strict'
import test from 'node:test'
import { formatAttachmentChip } from '../src/attachment-chip.ts'

test('attachment chip reports verified ingestion outcomes', () => {
  const attachments = [
    { name: 'screen.png', url: 'x', size: 1, contentType: 'image/png' },
    { name: 'report.pdf', url: 'x', size: 1, contentType: 'application/pdf' },
    { name: 'note.ogg', url: 'x', size: 1, contentType: 'audio/ogg' },
    { name: 'archive.rar', url: 'x', size: 1, contentType: 'application/rar' },
  ]
  assert.equal(formatAttachmentChip(attachments, {
    text: '', imageParts: [], imagePaths: [],
    imageNames: ['screen.png'],
    transcripts: [{ name: 'note.ogg', characters: 1_240 }],
    documents: [{ name: 'report.pdf', characters: 38_100 }],
    skipped: [{ name: 'archive.rar', reason: 'unsupported_type' }],
  }), [
    '📎 screen.png · vision ready',
    '📄 report.pdf · 38k chars extracted',
    '🎙️ note.ogg · 1k chars transcribed',
    '⚠️ archive.rar · unsupported',
  ].join('\n'))
})
