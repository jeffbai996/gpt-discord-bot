import { describe, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { rewriteEnvVar } from '../src/restart.ts'

const tmp = path.join(os.tmpdir(), `gpt-restart-test-${process.pid}`)
const envPath = path.join(tmp, '.env')

async function setup(initial: string) {
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  await fs.writeFile(envPath, initial)
}

describe('rewriteEnvVar', () => {
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  test('replaces an existing key in place', async () => {
    await setup('OPENAI_MODEL=gpt-5.6-luna\nDISCORD_BOT_TOKEN=abc\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6-sol$/m)
    // Other keys preserved.
    assert.match(body, /^DISCORD_BOT_TOKEN=abc$/m)
    // Only one model line — no duplicates.
    assert.equal(body.match(/^OPENAI_MODEL=/gm)!.length, 1)
  })

  test('preserves comments and ordering', async () => {
    const initial = '# secrets\nDISCORD_BOT_TOKEN=tok\n\n# admin\nGPT_ADMIN_ID=42\nOPENAI_MODEL=old\n'
    await setup(initial)
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    const lines = body.split('\n')
    assert.equal(lines[0], '# secrets')
    assert.equal(lines[3], '# admin')
    assert.equal(lines[4], 'GPT_ADMIN_ID=42')
    assert.equal(lines[5], 'OPENAI_MODEL=new')
  })

  test('appends a missing key with trailing newline', async () => {
    await setup('DISCORD_BOT_TOKEN=tok\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^DISCORD_BOT_TOKEN=tok$/m)
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6$/m)
    assert.ok(body.endsWith('\n'), 'file should end with a newline')
  })

  test('creates the file if it does not exist', async () => {
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.mkdir(tmp, { recursive: true })
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'gpt-5.6-sol')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL=gpt-5\.6$/m)
  })

  test('write is atomic (no .tmp left behind)', async () => {
    await setup('OPENAI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const entries = await fs.readdir(tmp)
    assert.deepEqual(entries.sort(), ['.env'])
  })

  test('does not match keys that share a prefix', async () => {
    await setup('OPENAI_MODEL_NICKNAME=robot\nOPENAI_MODEL=old\n')
    await rewriteEnvVar(envPath, 'OPENAI_MODEL', 'new')
    const body = await fs.readFile(envPath, 'utf8')
    assert.match(body, /^OPENAI_MODEL_NICKNAME=robot$/m)
    assert.match(body, /^OPENAI_MODEL=new$/m)
  })
})
