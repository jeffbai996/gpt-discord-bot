import { test } from 'node:test'
import assert from 'node:assert/strict'
import { processAttachments } from '../src/attachments.ts'

// Minimal stand-in for discord.js's Attachment type. processAttachments only
// reads url/name/size/contentType, so we don't need the full class.
function fakeAtt(overrides: Partial<{ url: string, name: string, size: number, contentType: string | null }>) {
  return {
    url: 'https://cdn.example/file.bin',
    name: 'file.bin',
    size: 1024,
    contentType: null,
    ...overrides
  } as any
}

// Stub openai client — only audio.transcriptions.create is called by the
// processor for audio mimes. Cast through `any` to skirt the full SDK shape.
const openaiStub = {
  audio: {
    transcriptions: {
      create: async (_args: any) => ({ text: 'fake transcription' })
    }
  }
} as any

test('processAttachments: empty list', async () => {
  const out = await processAttachments([], openaiStub)
  assert.equal(out.text, '')
  assert.deepEqual(out.imageParts, [])
  assert.deepEqual(out.skipped, [])
})

test('processAttachments: image becomes image_url part', async () => {
  const att = fakeAtt({
    url: 'https://cdn.example/cat.png',
    name: 'cat.png',
    size: 50_000,
    contentType: 'image/png'
  })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.imageParts.length, 1)
  assert.equal(out.imageParts[0].mimeType, 'image/png')
  assert.equal(out.imageParts[0].url, 'https://cdn.example/cat.png')
  assert.equal(out.skipped.length, 0)
})

test('processAttachments: oversized → too_large skip', async () => {
  const att = fakeAtt({ size: 100 * 1024 * 1024, contentType: 'image/png', name: 'big.png' })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'too_large')
  assert.equal(out.imageParts.length, 0)
})

test('processAttachments: unsupported mime → unsupported_type skip', async () => {
  const att = fakeAtt({ contentType: 'application/x-tar', name: 'archive.tar' })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'unsupported_type')
  // Skipped notice ends up in the text payload so the model knows about it.
  assert.match(out.text, /archive\.tar/)
  assert.match(out.text, /unsupported_type/)
})

test('processAttachments: handles charset suffix on contentType', async () => {
  const att = fakeAtt({
    url: 'https://cdn.example/img.jpg',
    name: 'img.jpg',
    size: 5000,
    contentType: 'image/jpeg; charset=binary'
  })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.imageParts.length, 1)
})
