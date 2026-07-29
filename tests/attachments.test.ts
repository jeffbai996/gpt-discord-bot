import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { cleanupAttachmentFiles, processAttachments } from '../src/attachments.ts'
import { zipSync, strToU8 } from 'fflate'

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
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('fake-image'), {
    status: 200,
    headers: { 'content-type': 'image/png' },
  })
  const out = await processAttachments([att], openaiStub)
  globalThis.fetch = originalFetch
  assert.equal(out.imageParts.length, 1)
  assert.equal(out.imageParts[0].type, 'image_url')
  assert.equal(out.imageParts[0].image_url.url, `data:image/png;base64,${Buffer.from('fake-image').toString('base64')}`)
  assert.equal(out.imagePaths.length, 1)
  await access(out.imagePaths[0])
  await cleanupAttachmentFiles(out.imagePaths)
  await assert.rejects(access(out.imagePaths[0]))
  assert.equal(out.skipped.length, 0)
})

test('processAttachments: reuses cached image bytes instead of downloading again', async () => {
  const att = fakeAtt({
    url: 'https://cdn.example/cache-once.png?signature=first',
    name: 'cache-once.png',
    size: 50_000,
    contentType: 'image/png',
  })
  const originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = async () => {
    fetches += 1
    return new Response(Buffer.from('cached-image'), { status: 200 })
  }

  try {
    const first = await processAttachments([att], openaiStub)
    await cleanupAttachmentFiles(first.imagePaths)
    const second = await processAttachments([
      { ...att, url: 'https://cdn.example/cache-once.png?signature=refreshed' },
    ], openaiStub)
    await cleanupAttachmentFiles(second.imagePaths)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(fetches, 1)
})

test('processAttachments: oversized → too_large skip', async () => {
  const att = fakeAtt({ size: 100 * 1024 * 1024, contentType: 'image/png', name: 'big.png' })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'too_large')
  assert.equal(out.imageParts.length, 0)
})

test('processAttachments: unsupported mime → unsupported_type skip', async () => {
  const att = fakeAtt({ contentType: 'application/x-msdownload', name: 'app.exe' })
  const out = await processAttachments([att], openaiStub)
  assert.equal(out.skipped.length, 1)
  assert.equal(out.skipped[0].reason, 'unsupported_type')
  // Skipped notice ends up in the text payload so the model knows about it.
  assert.match(out.text, /app\.exe/)
  assert.match(out.text, /unsupported_type/)
})

test('processAttachments: Office documents enter the document parser', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('not-a-real-docx'), { status: 200 })
  const out = await processAttachments([fakeAtt({
    name: 'plan.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })], openaiStub)
  globalThis.fetch = originalFetch
  assert.equal(out.skipped[0]?.reason, 'download_failed')
  assert.notEqual(out.skipped[0]?.reason, 'unsupported_type')
})

test('processAttachments: handles charset suffix on contentType', async () => {
  const att = fakeAtt({
    url: 'https://cdn.example/img.jpg',
    name: 'img.jpg',
    size: 5000,
    contentType: 'image/jpeg; charset=binary'
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('jpeg'), { status: 200 })
  const out = await processAttachments([att], openaiStub)
  globalThis.fetch = originalFetch
  assert.equal(out.imageParts.length, 1)
  await cleanupAttachmentFiles(out.imagePaths)
})

test('processAttachments: infers Discord voice-note MIME from .ogg when contentType is absent', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('opus-audio'), { status: 200 })
  let receivedType = ''
  const client = {
    audio: { transcriptions: { create: async ({ file }: any) => {
      receivedType = file.type
      return { text: 'voice note text' }
    } } },
  } as any
  const out = await processAttachments([
    fakeAtt({ name: 'voice-message.ogg', contentType: null, size: 11 }),
  ], client)
  globalThis.fetch = originalFetch
  assert.equal(receivedType, 'audio/ogg')
  assert.match(out.text, /voice note text/)
  assert.deepEqual(out.skipped, [])
})

test('processAttachments: infers Discord voice-note MIME through generic octet-stream', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(Buffer.from('opus-audio'), { status: 200 })
  let receivedType = ''
  const client = {
    audio: { transcriptions: { create: async ({ file }: any) => {
      receivedType = file.type
      return { text: 'generic mime voice note' }
    } } },
  } as any
  const out = await processAttachments([
    fakeAtt({ name: 'voice-message.ogg', contentType: 'application/octet-stream', size: 11 }),
  ], client)
  globalThis.fetch = originalFetch
  assert.equal(receivedType, 'audio/ogg')
  assert.match(out.text, /generic mime voice note/)
  assert.deepEqual(out.skipped, [])
})

test('processAttachments: failed image download is surfaced, not passed as a dead CDN URL', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('expired', { status: 403 })
  const out = await processAttachments([
    fakeAtt({ name: 'expired.png', contentType: 'image/png' }),
  ], openaiStub)
  globalThis.fetch = originalFetch
  assert.equal(out.imageParts.length, 0)
  assert.equal(out.skipped[0]?.reason, 'download_failed')
  assert.match(out.text, /expired\.png/)
})

test('processAttachments: extracts notebooks, email, SVG, subtitles, and data by extension', async () => {
  const fixtures: Array<[string, string, RegExp]> = [
    ['analysis.ipynb', JSON.stringify({ cells: [{ cell_type: 'code', source: ['print("hi")'], outputs: [] }] }), /print\("hi"\)/],
    ['message.eml', 'From: alice@example.com\\r\\nSubject: Hello\\r\\n\\r\\nMail body', /Mail body/],
    ['drawing.svg', '<svg><text>Hello SVG</text></svg>', /Hello SVG/],
    ['captions.srt', '1\\n00:00:00,000 --> 00:00:01,000\\nHello captions', /Hello captions/],
    ['events.jsonl', '{"event":"ready"}\\n', /ready/],
  ]
  const originalFetch = globalThis.fetch
  for (const [name, body, expected] of fixtures) {
    globalThis.fetch = async () => new Response(body, { status: 200 })
    const out = await processAttachments([fakeAtt({ name, contentType: 'application/octet-stream', size: body.length })], openaiStub)
    assert.match(out.text, expected)
    assert.deepEqual(out.skipped, [])
  }
  globalThis.fetch = originalFetch
})

test('processAttachments: extracts supported text members from ZIP archives', async () => {
  const zip = Buffer.from(zipSync({ 'notes/readme.md': strToU8('hello from archive') }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(zip, { status: 200 })
  const out = await processAttachments([fakeAtt({ name: 'bundle.zip', contentType: null, size: zip.length })], openaiStub)
  globalThis.fetch = originalFetch
  assert.match(out.text, /hello from archive/)
  assert.deepEqual(out.skipped, [])
})
