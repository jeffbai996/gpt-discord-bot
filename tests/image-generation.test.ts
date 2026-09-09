import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateImage } from '../src/image-generation.ts'
import { executeGptCommand, gptCommand } from '../src/commands.ts'

test('image slash schema is valid and the handler defers then attaches', async () => {
  assert.ok(gptCommand.toJSON().options?.some(x => x.name === 'image'))
  const original = globalThis.fetch
  const key = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'example-key'
  const events: string[] = []
  globalThis.fetch = async () => Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] })
  const interaction = {
    user: { id: 'example-admin' },
    options: { getSubcommand: () => 'image', getString: (name: string) => name === 'prompt' ? 'A cube' : null },
    deferReply: async () => { events.push('defer') },
    editReply: async (reply: any) => { events.push('attach'); assert.ok(Buffer.isBuffer(reply.files[0].attachment)) },
  }
  try {
    await executeGptCommand(interaction as any, {} as any, 'example-admin')
    assert.deepEqual(events, ['defer', 'attach'])
  } finally {
    globalThis.fetch = original
    if (key === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = key
  }
})

test('unauthorized image request stops before reading options or calling API', async () => {
  let denied = false
  await executeGptCommand({ user: { id: 'example-user' }, reply: async () => { denied = true } } as any, {} as any, 'example-admin')
  assert.equal(denied, true)
})

test('maps image options and decodes the attachment', async () => {
  const result = await generateImage('example-key', { prompt: 'A blue cube', size: '1536x1024', quality: 'low' }, async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'gpt-image-2', prompt: 'A blue cube', size: '1536x1024', quality: 'low', n: 1, output_format: 'png' })
    return Response.json({ data: [{ b64_json: Buffer.from('image').toString('base64') }] })
  })
  assert.equal(result.attachment.toString(), 'image')
  assert.equal(result.name, 'gpt-image.png')
})

test('rejects missing credentials without a request', async () => {
  await assert.rejects(generateImage('', { prompt: 'cube' }, async () => { throw new Error('called') }), /OPENAI_API_KEY/)
})

test('does not expose provider error bodies or retry billable requests', async () => {
  let calls = 0
  await assert.rejects(generateImage('key', { prompt: 'cube' }, async () => {
    calls++
    return Response.json({ error: { message: 'private diagnostic' } }, { status: 403 })
  }), /HTTP 403/)
  assert.equal(calls, 1)
})

test('rejects empty image responses', async () => {
  await assert.rejects(generateImage('key', { prompt: 'cube' }, async () => Response.json({ data: [] })), /no image/)
})
